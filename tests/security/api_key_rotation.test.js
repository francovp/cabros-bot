const request = require('supertest');
const express = require('express');
const { validateApiKey, isValidApiKey, getAuthKeyStatus } = require('../../src/lib/auth');

function buildApp() {
	const app = express();
	app.use(express.json());
	app.post('/protected', validateApiKey, (req, res) => {
		res.status(200).json({
			success: true,
			slot: req.apiKeySlot,
		});
	});
	return app;
}

describe('Security: API Key Rotation (CB-? / Issue #857)', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		delete process.env.ENABLE_API_KEY_ROTATION;
		delete process.env.WEBHOOK_API_KEY_PREVIOUS;
		delete process.env.WEBHOOK_API_KEY_PREVIOUS_EXPIRES_AT;
		delete process.env.WEBHOOK_API_KEY_NEXT;
	});

	afterEach(() => {
		restoreEnv(savedEnv);
	});

	describe('isValidApiKey with rotation disabled (default)', () => {
		beforeEach(() => {
			process.env.WEBHOOK_API_KEY = 'current-key';
		});

		it('accepts the active key only', async () => {
			const req = { headers: { 'x-api-key': 'current-key' } };
			expect(isValidApiKey(req)).toBe(true);
		});

		it('rejects other values when no rotation env is set', async () => {
			const req = { headers: { 'x-api-key': 'some-other-key' } };
			expect(isValidApiKey(req)).toBe(false);
		});
	});

	describe('isValidApiKey with rotation enabled', () => {
		beforeEach(() => {
			process.env.ENABLE_API_KEY_ROTATION = 'true';
			process.env.WEBHOOK_API_KEY = 'new-key';
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'old-key';
		});

		it('accepts the active slot key', async () => {
			const req = { headers: { 'x-api-key': 'new-key' } };
			expect(isValidApiKey(req)).toBe(true);
		});

		it('accepts the previous slot key during overlap', async () => {
			const req = { headers: { 'x-api-key': 'old-key' } };
			expect(isValidApiKey(req)).toBe(true);
		});

		it('rejects unknown keys', async () => {
			const req = { headers: { 'x-api-key': 'attacker-key' } };
			expect(isValidApiKey(req)).toBe(false);
		});

		it('accepts the next slot key when configured', async () => {
			process.env.WEBHOOK_API_KEY_NEXT = 'next-key';
			const req = { headers: { 'x-api-key': 'next-key' } };
			expect(isValidApiKey(req)).toBe(true);
		});

		it('still rejects an attacker key with a NEXT slot configured', async () => {
			process.env.WEBHOOK_API_KEY_NEXT = 'next-key';
			const req = { headers: { 'x-api-key': 'attacker-key' } };
			expect(isValidApiKey(req)).toBe(false);
		});

		it('treats empty WEBHOOK_API_KEY_PREVIOUS as a no-op', async () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS = '';
			const req = { headers: { 'x-api-key': 'old-key' } };
			expect(isValidApiKey(req)).toBe(false);
		});

		it('uses timingSafeEqual for every slot check', async () => {
			// Different length keys must NOT authenticate (Buffer length mismatch).
			const req = { headers: { 'x-api-key': 'short' } };
			expect(isValidApiKey(req)).toBe(false);
		});
	});

	describe('isValidApiKey with expired previous slot', () => {
		beforeEach(() => {
			process.env.ENABLE_API_KEY_ROTATION = 'true';
			process.env.WEBHOOK_API_KEY = 'new-key';
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'old-key';
		});

		it('rejects the previous key once the expiry timestamp is in the past', async () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS_EXPIRES_AT = '2000-01-01T00:00:00.000Z';
			const req = { headers: { 'x-api-key': 'old-key' } };
			expect(isValidApiKey(req)).toBe(false);
		});

		it('still accepts the previous key before its expiry timestamp', async () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS_EXPIRES_AT = '2999-12-31T23:59:59.000Z';
			const req = { headers: { 'x-api-key': 'old-key' } };
			expect(isValidApiKey(req)).toBe(true);
		});

		it('ignores a malformed expiry timestamp and still accepts the previous key', async () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS_EXPIRES_AT = 'not-a-date';
			const req = { headers: { 'x-api-key': 'old-key' } };
			expect(isValidApiKey(req)).toBe(true);
		});
	});

	describe('validateApiKey slot tagging', () => {
		beforeEach(() => {
			process.env.ENABLE_API_KEY_ROTATION = 'true';
			process.env.WEBHOOK_API_KEY = 'new-key';
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'old-key';
		});

		it('tags the current slot and sets X-Cabros-Key-Slot header', async () => {
			const res = await request(buildApp())
				.post('/protected')
				.set('x-api-key', 'new-key')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body.slot).toBe('current');
			expect(res.headers['x-cabros-key-slot']).toBe('current');
		});

		it('tags the previous slot during rotation overlap', async () => {
			const res = await request(buildApp())
				.post('/protected')
				.set('x-api-key', 'old-key')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body.slot).toBe('previous');
			expect(res.headers['x-cabros-key-slot']).toBe('previous');
		});

		it('tags the next slot when configured', async () => {
			process.env.WEBHOOK_API_KEY_NEXT = 'next-key';
			const res = await request(buildApp())
				.post('/protected')
				.set('x-api-key', 'next-key')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body.slot).toBe('next');
			expect(res.headers['x-cabros-key-slot']).toBe('next');
		});

		it('does not set X-Cabros-Key-Slot when rotation is disabled', async () => {
			delete process.env.ENABLE_API_KEY_ROTATION;
			const res = await request(buildApp())
				.post('/protected')
				.set('x-api-key', 'new-key')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body.slot).toBe('current');
			expect(res.headers['x-cabros-key-slot']).toBeUndefined();
		});

		it('rejects expired previous slot with 403 even when the key string is correct', async () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS_EXPIRES_AT = '2000-01-01T00:00:00.000Z';
			const res = await request(buildApp())
				.post('/protected')
				.set('x-api-key', 'old-key')
				.send({});

			expect(res.status).toBe(403);
		});
	});

	describe('getAuthKeyStatus', () => {
		it('returns disabled state when ENABLE_API_KEY_ROTATION is unset', () => {
			process.env.WEBHOOK_API_KEY = 'current-key';
			const status = getAuthKeyStatus();
			expect(status.enabled).toBe(false);
			expect(status.configured).toBe(true);
			expect(status.slots).toEqual(['current']);
			expect(status.previousExpiresAt).toBeNull();
		});

		it('returns configured slots when rotation is enabled', () => {
			process.env.ENABLE_API_KEY_ROTATION = 'true';
			process.env.WEBHOOK_API_KEY = 'new-key';
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'old-key';
			process.env.WEBHOOK_API_KEY_PREVIOUS_EXPIRES_AT = '2999-12-31T23:59:59.000Z';
			const status = getAuthKeyStatus();
			expect(status.enabled).toBe(true);
			expect(status.slots).toEqual(['current', 'previous']);
			expect(status.previousExpiresAt).toBe('2999-12-31T23:59:59.000Z');
		});

		it('includes next slot when configured', () => {
			process.env.ENABLE_API_KEY_ROTATION = 'true';
			process.env.WEBHOOK_API_KEY = 'new-key';
			process.env.WEBHOOK_API_KEY_NEXT = 'next-key';
			const status = getAuthKeyStatus();
			expect(status.slots).toEqual(['current', 'next']);
		});

		it('omits previous slot when the previous value is empty', () => {
			process.env.ENABLE_API_KEY_ROTATION = 'true';
			process.env.WEBHOOK_API_KEY = 'new-key';
			process.env.WEBHOOK_API_KEY_PREVIOUS = '   ';
			const status = getAuthKeyStatus();
			expect(status.slots).toEqual(['current']);
		});

		it('reports configured=false when no current key is set', () => {
			process.env.ENABLE_API_KEY_ROTATION = 'true';
			delete process.env.WEBHOOK_API_KEY;
			const status = getAuthKeyStatus();
			expect(status.enabled).toBe(true);
			expect(status.configured).toBe(false);
		});
	});
});
