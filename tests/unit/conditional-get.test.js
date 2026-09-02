'use strict';

const express = require('express');
const request = require('supertest');
const conditionalGet = require('../../src/lib/conditionalGet');

function buildApp(handler) {
	const app = express();
	app.get('/probe', conditionalGet.withConditionalGet(handler));
	return app;
}

describe('conditionalGet middleware', () => {
	beforeEach(() => {
		conditionalGet.resetForTesting();
		delete process.env.ENABLE_HTTP_CONDITIONAL_GET;
	});

	afterEach(() => {
		conditionalGet.resetForTesting();
		delete process.env.ENABLE_HTTP_CONDITIONAL_GET;
	});

	it('emits ETag and Cache-Control on a 200 response when enabled', async () => {
		const app = buildApp((req, res) => res.json({ value: 1 }));
		const response = await request(app).get('/probe');

		expect(response.status).toBe(200);
		expect(response.headers.etag).toMatch(/^W\/"[A-Za-z0-9+/=]+"$/);
		expect(response.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
		expect(response.body).toEqual({ value: 1 });
	});

	it('returns 304 with empty body when If-None-Match matches the ETag', async () => {
		const app = buildApp((req, res) => res.json({ value: 1 }));

		const first = await request(app).get('/probe');
		expect(first.status).toBe(200);
		const etag = first.headers.etag;

		const second = await request(app).get('/probe').set('If-None-Match', etag);
		expect(second.status).toBe(304);
		expect(second.body).toEqual({});
		expect(second.headers.etag).toBe(etag);
		expect(second.headers['x-conditional-get']).toBe('hit');
	});

	it('accepts weak-validator-prefixed ETag values in If-None-Match', async () => {
		const app = buildApp((req, res) => res.json({ value: 1 }));

		const first = await request(app).get('/probe');
		const etag = first.headers.etag.replace(/^W\//, '');

		const second = await request(app).get('/probe').set('If-None-Match', etag);
		expect(second.status).toBe(304);
	});

	it('returns 200 with a new body when If-None-Match does not match', async () => {
		const app = buildApp((req, res) => res.json({ value: 1 }));

		const second = await request(app)
			.get('/probe')
			.set('If-None-Match', 'W/"definitely-not-matching"');
		expect(second.status).toBe(200);
		expect(second.body).toEqual({ value: 1 });
		expect(second.headers['x-conditional-get']).toBe('miss');
	});

	it('returns 200 (no short-circuit) when the gate flag is disabled', async () => {
		process.env.ENABLE_HTTP_CONDITIONAL_GET = 'false';
		const app = buildApp((req, res) => res.json({ value: 1 }));

		const first = await request(app).get('/probe');
		expect(first.status).toBe(200);
		expect(conditionalGet.isEnabled()).toBe(false);
		expect(first.headers.etag).toBeUndefined();

		const second = await request(app)
			.get('/probe')
			.set('If-None-Match', first.headers.etag || 'W/"any"');
		expect(second.status).toBe(200);
	});

	it('treats `*` as a match for If-None-Match', async () => {
		const app = buildApp((req, res) => res.json({ value: 1 }));

		const first = await request(app).get('/probe');
		expect(first.status).toBe(200);

		const second = await request(app).get('/probe').set('If-None-Match', '*');
		expect(second.status).toBe(304);
	});

	it('does not wrap POST handlers', async () => {
		const app = express();
		app.post('/probe', conditionalGet.withConditionalGet((req, res) => res.json({ ok: true })));

		const response = await request(app).post('/probe').send({});
		expect(response.status).toBe(200);
		expect(response.headers.etag).toBeUndefined();
	});

	it('records hit and miss counters in snapshotStats', async () => {
		const app = buildApp((req, res) => res.json({ value: 1 }));

		const first = await request(app).get('/probe');
		await request(app).get('/probe').set('If-None-Match', first.headers.etag);
		await request(app).get('/probe');

		const stats = conditionalGet.snapshotStats();
		expect(stats.enabled).toBe(true);
		expect(stats.etagHits).toBe(1);
		expect(stats.etagMisses).toBeGreaterThanOrEqual(1);
		expect(stats.shortCircuitedResponses).toBe(1);
		expect(stats.bodyBytesSaved).toBeGreaterThan(0);
	});

	it('etagFor derives a stable ETag from version metadata', () => {
		const first = conditionalGet.etagFor({ updatedAt: '2026-01-01T00:00:00Z', count: 5, version: 2 });
		const second = conditionalGet.etagFor({ updatedAt: '2026-01-01T00:00:00Z', count: 5, version: 2 });
		const different = conditionalGet.etagFor({ updatedAt: '2026-01-01T00:00:00Z', count: 6, version: 2 });

		expect(first).toBe(second);
		expect(first).not.toBe(different);
	});

	it('etagFor returns null for missing updatedAt', () => {
		expect(conditionalGet.etagFor({ count: 5, version: 2 })).toBeNull();
		expect(conditionalGet.etagFor({})).toBeNull();
	});

	it('buildCacheControl emits a default must-revalidate header', () => {
		expect(conditionalGet.buildCacheControl()).toBe('private, max-age=0, must-revalidate');
		expect(conditionalGet.buildCacheControl({ maxAge: 30 })).toBe(
			'private, max-age=30, must-revalidate',
		);
		expect(conditionalGet.buildCacheControl({ maxAge: 30, mustRevalidate: false })).toBe(
			'private, max-age=30',
		);
	});

	it('parseIfNoneMatch splits, trims, and filters empty tokens', () => {
		expect(conditionalGet.parseIfNoneMatch(' W/"a" , , W/"b" ,')).toEqual(['W/"a"', 'W/"b"']);
		expect(conditionalGet.parseIfNoneMatch('')).toEqual([]);
		expect(conditionalGet.parseIfNoneMatch(undefined)).toEqual([]);
	});

	it('ifNoneMatchMatches handles wildcards, exact matches, and weak-validator stripping', () => {
		expect(conditionalGet.ifNoneMatchMatches('*', 'W/"abc"')).toBe(true);
		expect(conditionalGet.ifNoneMatchMatches('W/"abc"', 'W/"abc"')).toBe(true);
		expect(conditionalGet.ifNoneMatchMatches('"abc"', 'W/"abc"')).toBe(true);
		expect(conditionalGet.ifNoneMatchMatches('W/"xyz"', 'W/"abc"')).toBe(false);
		expect(conditionalGet.ifNoneMatchMatches('', 'W/"abc"')).toBe(false);
		expect(conditionalGet.ifNoneMatchMatches(null, 'W/"abc"')).toBe(false);
	});

	it('preserves a handler-set ETag (e.g. optimistic-concurrency) and still emits Cache-Control', async () => {
		const app = buildApp((req, res) => {
			res.setHeader('ETag', '"42"');
			res.json({ value: 1 });
		});

		const response = await request(app).get('/probe');
		expect(response.status).toBe(200);
		expect(response.headers.etag).toBe('"42"');
		expect(response.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
		expect(response.headers['x-conditional-get']).toBe('pass-through');
	});
});
