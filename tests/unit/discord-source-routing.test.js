const {
	parseDiscordSourceRouting,
	resolveDiscordWebhookForAlert,
	summarizeDiscordSourceRouting,
	isValidDiscordWebhookUrl,
	resetAggregateStatsForTesting,
	getAggregateStats,
	SOURCE_ALIAS_GROUPS,
} = require('../../src/services/notification/discordSourceRouting');

describe('discordSourceRouting', () => {
	let mockLogger;

	beforeEach(() => {
		mockLogger = {
			debug: jest.fn(),
			info: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
		};
		resetAggregateStatsForTesting();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('parseDiscordSourceRouting', () => {
		it('returns empty object for null/undefined/empty inputs', () => {
			expect(parseDiscordSourceRouting(null)).toEqual({});
			expect(parseDiscordSourceRouting(undefined)).toEqual({});
			expect(parseDiscordSourceRouting('')).toEqual({});
		});

		it('parses JSON string config and lowercases keys', () => {
			const json = JSON.stringify({
				'Market-Scanner': 'https://discord.com/api/webhooks/111/scanner',
				'NEWS-MONITOR': 'https://discord.com/api/webhooks/222/news',
			});
			const result = parseDiscordSourceRouting(json, mockLogger);
			expect(result).toEqual({
				'market-scanner': 'https://discord.com/api/webhooks/111/scanner',
				'news-monitor': 'https://discord.com/api/webhooks/222/news',
			});
		});

		it('parses object config directly', () => {
			const result = parseDiscordSourceRouting(
				{ scanner: 'https://discord.com/api/webhooks/333/scan' },
				mockLogger,
			);
			expect(result).toEqual({
				scanner: 'https://discord.com/api/webhooks/333/scan',
			});
		});

		it('warns and returns empty object for malformed JSON', () => {
			const result = parseDiscordSourceRouting('{ "key": , "broken" }', mockLogger);
			expect(result).toEqual({});
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('malformed JSON'),
			);
		});

		it('warns and returns empty object for non-JSON string', () => {
			const result = parseDiscordSourceRouting('scanner=https://x', mockLogger);
			expect(result).toEqual({});
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('non-JSON routing config'),
			);
		});

		it('warns and returns empty object for non-object input', () => {
			expect(parseDiscordSourceRouting([1, 2, 3], mockLogger)).toEqual({});
			expect(parseDiscordSourceRouting('[]', mockLogger)).toEqual({});
			expect(mockLogger.warn).toHaveBeenCalled();
		});

		it('skips empty string URLs with a warning', () => {
			const json = JSON.stringify({
				'market-scanner': '   ',
				'news-monitor': 'https://discord.com/api/webhooks/222/news',
			});
			const result = parseDiscordSourceRouting(json, mockLogger);
			expect(result).toEqual({
				'news-monitor': 'https://discord.com/api/webhooks/222/news',
			});
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('empty webhook URL'),
			);
		});

		it('ignores non-string values with a warning', () => {
			const json = JSON.stringify({
				'market-scanner': 12345,
				'news-monitor': 'https://discord.com/api/webhooks/222/news',
			});
			const result = parseDiscordSourceRouting(json, mockLogger);
			expect(result).toEqual({
				'news-monitor': 'https://discord.com/api/webhooks/222/news',
			});
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('non-string webhook URL'),
			);
		});
	});

	describe('resolveDiscordWebhookForAlert', () => {
		const defaultWebhook = 'https://discord.com/api/webhooks/000/default';
		const scannerWebhook = 'https://discord.com/api/webhooks/111/scanner';
		const newsWebhook = 'https://discord.com/api/webhooks/222/news';

		const routes = {
			scanner: scannerWebhook,
			'market-scanner-alert': scannerWebhook,
			'news-monitor': newsWebhook,
			default: defaultWebhook,
		};

		it('returns default webhook when routes is empty', () => {
			const result = resolveDiscordWebhookForAlert(
				{ source: 'market-scanner' },
				{},
				defaultWebhook,
			);
			expect(result).toEqual({ webhookUrl: defaultWebhook, routeKey: null });
		});

		it('resolves an exact source match', () => {
			const result = resolveDiscordWebhookForAlert(
				{ source: 'scanner' },
				routes,
				defaultWebhook,
			);
			expect(result).toEqual({ webhookUrl: scannerWebhook, routeKey: 'scanner' });
		});

		it('resolves via alias group match', () => {
			const result = resolveDiscordWebhookForAlert(
				{ source: 'market-scanner' },
				routes,
				defaultWebhook,
			);
			expect(result.routeKey).toBe('scanner');
			expect(result.webhookUrl).toBe(scannerWebhook);
		});

		it('falls back to default when no source matches', () => {
			const result = resolveDiscordWebhookForAlert(
				{ source: 'unknown-source' },
				routes,
				defaultWebhook,
			);
			expect(result).toEqual({ webhookUrl: defaultWebhook, routeKey: 'default' });
		});

		it('falls back to default when no alert metadata is provided', () => {
			const result = resolveDiscordWebhookForAlert(
				{ text: 'hello' },
				routes,
				defaultWebhook,
			);
			expect(result).toEqual({ webhookUrl: defaultWebhook, routeKey: 'default' });
		});

		it('returns default webhook and warns when matched route has empty URL', () => {
			const result = resolveDiscordWebhookForAlert(
				{ source: 'news-monitor' },
				{ 'news-monitor': '   ', default: defaultWebhook },
				defaultWebhook,
				mockLogger,
			);
			expect(result.webhookUrl).toBe(defaultWebhook);
			expect(result.routeKey).toBe('news-monitor');
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Empty webhook for resolved route'),
			);
		});

		it('increments aggregate stats on every resolution', () => {
			resolveDiscordWebhookForAlert({ source: 'scanner' }, routes, defaultWebhook, mockLogger);
			resolveDiscordWebhookForAlert({ source: 'unknown' }, routes, defaultWebhook, mockLogger);
			resolveDiscordWebhookForAlert({}, routes, defaultWebhook, mockLogger);
			const stats = getAggregateStats();
			expect(stats.decisions).toBe(3);
			expect(stats.fallbacks).toBe(2);
		});

		it('uses category, type, setupType, eventCategory, and topic as fallbacks', () => {
			const result = resolveDiscordWebhookForAlert(
				{ category: 'market-scanner' },
				routes,
				defaultWebhook,
			);
			expect(result.routeKey).toBe('scanner');
		});

		it('prefers source over category', () => {
			const result = resolveDiscordWebhookForAlert(
				{ source: 'news-monitor', category: 'scanner' },
				routes,
				defaultWebhook,
			);
			expect(result.routeKey).toBe('news-monitor');
		});

		it('treats source alias groups symmetrically (news-monitor maps to news-monitor)', () => {
			const newsOnly = {
				'news-monitor': newsWebhook,
			};
			const result = resolveDiscordWebhookForAlert(
				{ source: 'news' },
				newsOnly,
				defaultWebhook,
			);
			expect(result.routeKey).toBe('news-monitor');
			expect(result.webhookUrl).toBe(newsWebhook);
		});
	});

	describe('summarizeDiscordSourceRouting', () => {
		it('returns disabled summary when routes is empty', () => {
			const summary = summarizeDiscordSourceRouting({});
			expect(summary).toEqual({
				enabled: false,
				routesConfigured: 0,
				keys: [],
				hasDefault: false,
			});
		});

		it('returns enabled summary with sorted key list', () => {
			const summary = summarizeDiscordSourceRouting({
				scanner: 'https://discord.com/api/webhooks/1/a',
				news: 'https://discord.com/api/webhooks/2/b',
				default: 'https://discord.com/api/webhooks/0/c',
			});
			expect(summary.enabled).toBe(true);
			expect(summary.routesConfigured).toBe(3);
			expect(summary.keys).toEqual(['default', 'news', 'scanner']);
			expect(summary.hasDefault).toBe(true);
		});

		it('detects wildcard default fallback', () => {
			const summary = summarizeDiscordSourceRouting({
				'*': 'https://discord.com/api/webhooks/0/c',
			});
			expect(summary.hasDefault).toBe(true);
		});
	});

	describe('isValidDiscordWebhookUrl', () => {
		it('accepts discord.com webhook URLs', () => {
			expect(isValidDiscordWebhookUrl('https://discord.com/api/webhooks/123/abc')).toBe(true);
			expect(isValidDiscordWebhookUrl('https://canary.discord.com/api/webhooks/123/abc')).toBe(true);
			expect(isValidDiscordWebhookUrl('https://discordapp.com/api/webhooks/123/abc')).toBe(true);
		});

		it('rejects non-Discord hosts', () => {
			expect(isValidDiscordWebhookUrl('https://attacker.com/api/webhooks/123/abc')).toBe(false);
		});

		it('rejects non-HTTPS protocols', () => {
			expect(isValidDiscordWebhookUrl('http://discord.com/api/webhooks/123/abc')).toBe(false);
		});

		it('rejects malformed URLs', () => {
			expect(isValidDiscordWebhookUrl('not a url')).toBe(false);
			expect(isValidDiscordWebhookUrl('')).toBe(false);
			expect(isValidDiscordWebhookUrl(null)).toBe(false);
			expect(isValidDiscordWebhookUrl(123)).toBe(false);
		});

		it('rejects paths without valid webhook structure', () => {
			expect(isValidDiscordWebhookUrl('https://discord.com/api/webhooks/')).toBe(false);
			expect(isValidDiscordWebhookUrl('https://discord.com/api/webhooks/abc/def')).toBe(false);
		});
	});

	describe('SOURCE_ALIAS_GROUPS', () => {
		it('exposes alias groups for each major alert source', () => {
			expect(SOURCE_ALIAS_GROUPS).toEqual(
				expect.arrayContaining([
					expect.arrayContaining(['market-scanner']),
					expect.arrayContaining(['news-monitor']),
					expect.arrayContaining(['expanded-analysis']),
					expect.arrayContaining(['webhook-alert']),
				]),
			);
		});
	});
});