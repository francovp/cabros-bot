'use strict';

const fs = require('fs');
const path = require('path');
const {
	channelIdFromName,
	siteFromName,
	parseArgs,
	parseChannelList,
	selectExpiredPreviewChannels,
	buildDeleteArgs,
	recordCleanupLog,
	DEFAULT_PROJECT,
	DEFAULT_MAX_AGE_DAYS,
} = require('../../scripts/cleanup-preview-channels');

describe('cleanup-preview-channels tool', () => {
	const testLogPath = path.join(__dirname, '../fixtures/test-preview-channels-cleanup.log');

	afterEach(() => {
		if (fs.existsSync(testLogPath)) {
			fs.unlinkSync(testLogPath);
		}
	});

	describe('parseArgs', () => {
		it('defaults to dry-run with 3-day age and cabros-bot project', () => {
			const args = parseArgs([]);
			expect(args.dryRun).toBe(true);
			expect(args.apply).toBe(false);
			expect(args.project).toBe(DEFAULT_PROJECT);
			expect(args.maxAgeDays).toBe(DEFAULT_MAX_AGE_DAYS);
		});

		it('applies --apply, --max-age-days, --project, --site, and --log-file', () => {
			const args = parseArgs([
				'--apply',
				'--max-age-days',
				'7',
				'--project',
				'other-proj',
				'--site',
				'other-site',
				'--log-file',
				testLogPath,
			]);
			expect(args.apply).toBe(true);
			expect(args.dryRun).toBe(false);
			expect(args.maxAgeDays).toBe(7);
			expect(args.project).toBe('other-proj');
			expect(args.site).toBe('other-site');
			expect(args.logFile).toBe(testLogPath);
		});

		it('--dry-run overrides apply', () => {
			const args = parseArgs(['--apply', '--dry-run']);
			expect(args.apply).toBe(false);
			expect(args.dryRun).toBe(true);
		});

		it('rejects invalid or non-positive --max-age-days', () => {
			expect(() => parseArgs(['--max-age-days', '0'])).toThrow(/positive number/i);
			expect(() => parseArgs(['--max-age-days', 'abc'])).toThrow(/positive number/i);
		});

		it('rejects unknown options', () => {
			expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/i);
		});
	});

	describe('channel name parsing', () => {
		it('extracts channelId and site from a resource name', () => {
			const name = 'projects/cabros-bot/sites/cabros-bot/channels/pr-123';
			expect(channelIdFromName(name)).toBe('pr-123');
			expect(siteFromName(name)).toBe('cabros-bot');
		});

		it('returns null for malformed names', () => {
			expect(channelIdFromName(null)).toBeNull();
			expect(channelIdFromName('')).toBeNull();
			expect(siteFromName('projects/cabros-bot/channels/x')).toBeNull();
		});
	});

	describe('parseChannelList', () => {
		const channel = { name: 'projects/cabros-bot/sites/cabros-bot/channels/pr-1' };

		it('parses the firebase CLI success envelope', () => {
			const raw = JSON.stringify({ status: 'success', result: { channels: [channel] } });
			expect(parseChannelList(raw)).toEqual([channel]);
		});

		it('parses a bare { channels } object and a raw array', () => {
			expect(parseChannelList({ channels: [channel] })).toEqual([channel]);
			expect(parseChannelList([channel])).toEqual([channel]);
		});

		it('returns empty array for unknown shapes', () => {
			expect(parseChannelList(undefined)).toEqual([]);
			expect(parseChannelList({ result: {} })).toEqual([]);
		});

		it('throws on malformed JSON string', () => {
			expect(() => parseChannelList('{not json')).toThrow(/Failed to parse/i);
		});
	});

	describe('selectExpiredPreviewChannels', () => {
		const now = '2026-08-29T00:00:00Z';
		const mk = (channelId, createTime) => ({
			name: `projects/cabros-bot/sites/cabros-bot/channels/${channelId}`,
			createTime,
			url: `https://preview-${channelId}.web.app`,
		});

		it('marks only non-live channels created before the cutoff', () => {
			const channels = [
				mk('live', '2026-08-01T00:00:00Z'), // live must survive
				mk('pr-100', '2026-08-01T00:00:00Z'), // old preview -> delete
				mk('pr-200', '2026-08-28T00:00:00Z'), // recent preview -> keep
			];
			const result = selectExpiredPreviewChannels(channels, { maxAgeDays: 3, now });
			expect(result.map((c) => c.channelId)).toEqual(['pr-100']);
		});

		it('skips channels without a parseable createTime', () => {
			const channels = [
				mk('pr-300', null),
				{ name: 'projects/cabros-bot/sites/cabros-bot/channels/pr-301', createTime: 'not-a-date' },
			];
			expect(selectExpiredPreviewChannels(channels, { maxAgeDays: 3, now })).toEqual([]);
		});

		it('applies custom maxAgeDays', () => {
			const channels = [
				mk('pr-50', '2026-08-28T00:00:00Z'), // 1 day old
				mk('pr-60', '2026-08-20T00:00:00Z'), // 9 days old
			];
			expect(selectExpiredPreviewChannels(channels, { maxAgeDays: 1, now }).map((c) => c.channelId)).toEqual([
				'pr-60',
			]);
			expect(selectExpiredPreviewChannels(channels, { maxAgeDays: 10, now })).toEqual([]);
		});

		it('never returns the live channel regardless of age', () => {
			const result = selectExpiredPreviewChannels([mk('live', '2020-01-01T00:00:00Z')], { maxAgeDays: 3, now });
			expect(result).toEqual([]);
		});
	});

	describe('buildDeleteArgs', () => {
		it('builds a forced, JSON output delete command with site and project', () => {
			const args = buildDeleteArgs({ channelId: 'pr-100', site: 'cabros-bot' }, { project: 'cabros-bot' });
			expect(args).toEqual([
				'hosting:channel:delete',
				'pr-100',
				'--force',
				'--json',
				'--project',
				'cabros-bot',
				'--site',
				'cabros-bot',
			]);
		});

		it('omits --site when unknown and a site fallback is present', () => {
			const args = buildDeleteArgs({ channelId: 'pr-100', site: null }, { project: 'x', site: 'fallback' });
			expect(args).toContain('--site');
			expect(args[args.length - 1]).toBe('fallback');
		});

		it('omits --site entirely when no site is resolvable', () => {
			const args = buildDeleteArgs({ channelId: 'pr-100', site: null }, { project: 'x' });
			expect(args).not.toContain('--site');
		});
	});

	describe('recordCleanupLog', () => {
		it('appends a timestamped audit line for deleted channels', () => {
			const line = recordCleanupLog({
				project: 'cabros-bot',
				maxAgeDays: 3,
				deletions: ['pr-100', 'pr-200'],
				logFile: testLogPath,
			});
			expect(fs.existsSync(testLogPath)).toBe(true);
			expect(line).toContain('PROJECT=cabros-bot');
			expect(line).toContain('MAX_AGE_DAYS=3');
			expect(line).toContain('DELETED=2');
			expect(line).toContain('CHANNELS=pr-100,pr-200');
		});
	});
});