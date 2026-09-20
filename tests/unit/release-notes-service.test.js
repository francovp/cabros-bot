'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
	ReleaseNotesService,
	DEFAULT_LIMIT,
	MAX_LIMIT,
	VALID_TYPES,
} = require('../../src/services/releaseNotes/ReleaseNotesService');

function createTempChangelog(entries) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
	const file = path.join(dir, 'changelog.json');
	const payload = {
		version: '0.1.0',
		generatedAt: '2026-09-01T00:00:00.000Z',
		branch: 'master',
		sinceTag: 'v0.1.0',
		sinceDate: null,
		entries,
	};
	fs.writeFileSync(file, JSON.stringify(payload, null, 2));
	return { dir, file };
}

describe('ReleaseNotesService', () => {
	let service;
	let tempFile;
	let tempDir;

	afterEach(() => {
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	describe('loadChangelog', () => {
		it('returns an empty changelog when the file does not exist', () => {
			const fakePath = path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`);
			service = new ReleaseNotesService({ changelogPath: fakePath });
			const changelog = service.loadChangelog();
			expect(changelog.entries).toEqual([]);
			expect(changelog.reason).toBe('changelog_not_generated');
		});

		it('parses a valid changelog file', () => {
			const created = createTempChangelog([
				{
					type: 'feat',
					scope: 'webhook',
					summary: 'add alert enrichment (#100)',
					breaking: false,
					pr: 100,
					author: 'a',
					mergedAt: '2026-09-01T00:00:00Z',
					commitSha: 'abc',
					shortSha: 'abc123',
					issues: [100],
				},
			]);
			tempDir = created.dir;
			tempFile = created.file;
			service = new ReleaseNotesService({ changelogPath: tempFile });
			const changelog = service.loadChangelog();
			expect(changelog.entries).toHaveLength(1);
			expect(changelog.entries[0].type).toBe('feat');
			expect(changelog.version).toBe('0.1.0');
		});

		it('returns malformed payload when entries is missing', () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
			const file = path.join(dir, 'changelog.json');
			fs.writeFileSync(file, JSON.stringify({ version: '1.0.0' }));
			tempDir = dir;
			service = new ReleaseNotesService({ changelogPath: file });
			const changelog = service.loadChangelog();
			expect(changelog.entries).toEqual([]);
			expect(changelog.reason).toBe('changelog_malformed');
		});
	});

	describe('parseLimit', () => {
		beforeEach(() => {
			service = new ReleaseNotesService({ changelogPath: '/dev/null' });
		});

		it('returns the default when undefined', () => {
			expect(service.parseLimit(undefined)).toBe(DEFAULT_LIMIT);
		});

		it('accepts integers in range', () => {
			expect(service.parseLimit('10')).toBe(10);
			expect(service.parseLimit('1')).toBe(1);
			expect(service.parseLimit(String(MAX_LIMIT))).toBe(MAX_LIMIT);
		});

		it('rejects out-of-range values', () => {
			expect(service.parseLimit('0')).toBeNull();
			expect(service.parseLimit('-1')).toBeNull();
			expect(service.parseLimit(String(MAX_LIMIT + 1))).toBeNull();
			expect(service.parseLimit('abc')).toBeNull();
		});
	});

	describe('parseTypes', () => {
		beforeEach(() => {
			service = new ReleaseNotesService({ changelogPath: '/dev/null' });
		});

		it('returns undefined when not provided', () => {
			expect(service.parseTypes(undefined)).toBeUndefined();
		});

		it('splits comma-separated values', () => {
			expect(service.parseTypes('feat,fix,perf')).toEqual(['feat', 'fix', 'perf']);
		});

		it('lowercases values', () => {
			expect(service.parseTypes('FEAT,Fix')).toEqual(['feat', 'fix']);
		});

		it('rejects invalid types', () => {
			const result = service.parseTypes('feat,bogus');
			expect(result.error).toMatch(/Invalid changelog type/);
		});
	});

	describe('parseSince', () => {
		beforeEach(() => {
			service = new ReleaseNotesService({ changelogPath: '/dev/null' });
		});

		it('returns undefined when not provided', () => {
			expect(service.parseSince(undefined)).toBeUndefined();
		});

		it('accepts ISO-8601 strings', () => {
			const value = service.parseSince('2026-09-01T00:00:00Z');
			expect(value).toBe('2026-09-01T00:00:00.000Z');
		});

		it('rejects invalid timestamps', () => {
			expect(service.parseSince('not a date').error).toMatch(/Invalid since/);
			expect(service.parseSince('').error).toMatch(/Invalid since/);
		});
	});

	describe('listEntries', () => {
		beforeEach(() => {
			const created = createTempChangelog([
				{
					type: 'feat',
					summary: 'add A',
					mergedAt: '2026-09-03T00:00:00Z',
					commitSha: 'a',
				},
				{
					type: 'fix',
					summary: 'fix B',
					mergedAt: '2026-09-02T00:00:00Z',
					commitSha: 'b',
				},
				{
					type: 'feat',
					summary: 'add C',
					mergedAt: '2026-09-01T00:00:00Z',
					commitSha: 'c',
				},
			]);
			tempDir = created.dir;
			tempFile = created.file;
			service = new ReleaseNotesService({ changelogPath: tempFile });
		});

		it('sorts newest first', () => {
			const entries = service.listEntries({ limit: 5 });
			expect(entries.map((e) => e.commitSha)).toEqual(['a', 'b', 'c']);
		});

		it('filters by type', () => {
			const entries = service.listEntries({ limit: 5, types: ['feat'] });
			expect(entries.every((e) => e.type === 'feat')).toBe(true);
			expect(entries).toHaveLength(2);
		});

		it('filters by since date', () => {
			const entries = service.listEntries({
				limit: 5,
				since: '2026-09-02T00:00:00Z',
			});
			expect(entries).toHaveLength(2);
		});

		it('caps by limit', () => {
			const entries = service.listEntries({ limit: 1 });
			expect(entries).toHaveLength(1);
			expect(entries[0].commitSha).toBe('a');
		});
	});

	describe('getSummary', () => {
		beforeEach(() => {
			const created = createTempChangelog([
				{
					type: 'feat',
					summary: 'add A',
					mergedAt: '2026-09-03T00:00:00Z',
					commitSha: 'a',
				},
				{
					type: 'fix',
					summary: 'fix B',
					mergedAt: '2026-09-02T00:00:00Z',
					commitSha: 'b',
				},
			]);
			tempDir = created.dir;
			tempFile = created.file;
			service = new ReleaseNotesService({ changelogPath: tempFile });
		});

		it('returns counts and day buckets', () => {
			const summary = service.getSummary({ limit: 5 });
			expect(summary.total).toBe(2);
			expect(summary.counts).toEqual({ feat: 1, fix: 1 });
			expect(summary.days).toEqual({
				'2026-09-03': 1,
				'2026-09-02': 1,
			});
			expect(summary.entries).toHaveLength(2);
		});
	});

	describe('getVersion', () => {
		beforeEach(() => {
			const created = createTempChangelog([
				{
					type: 'feat',
					summary: 'add A',
					mergedAt: '2026-09-03T00:00:00Z',
					commitSha: 'a',
				},
				{
					type: 'feat',
					summary: 'add B',
					mergedAt: '2026-08-15T00:00:00Z',
					commitSha: 'b',
				},
			]);
			tempDir = created.dir;
			tempFile = created.file;
			service = new ReleaseNotesService({ changelogPath: tempFile });
		});

		it('returns the full snapshot for the configured version', () => {
			const snapshot = service.getVersion('0.1.0');
			expect(snapshot).not.toBeNull();
			expect(snapshot.version).toBe('0.1.0');
			expect(snapshot.entries).toHaveLength(2);
		});

		it('returns entries merged on or after a date version', () => {
			const snapshot = service.getVersion('2026-09-01');
			expect(snapshot.entries).toHaveLength(1);
			expect(snapshot.entries[0].commitSha).toBe('a');
		});

		it('returns null for an invalid identifier', () => {
			expect(service.getVersion('not a date and not the version')).toBeNull();
		});
	});
});
