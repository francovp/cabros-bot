'use strict';

const {
	parseTelegramTopicRoutes,
	resolveTelegramThreadId,
} = require('../../src/services/notification/telegramTopicRouting');

describe('telegramTopicRouting', () => {
	describe('parseTelegramTopicRoutes', () => {
		it('returns empty object for falsy or empty inputs', () => {
			expect(parseTelegramTopicRoutes('')).toEqual({});
			expect(parseTelegramTopicRoutes(null)).toEqual({});
			expect(parseTelegramTopicRoutes(undefined)).toEqual({});
		});

		it('parses comma-separated key:threadId string', () => {
			const raw = 'webhook-signal:101,market-scanner:202,news-monitor:303,default:0';
			const result = parseTelegramTopicRoutes(raw);
			expect(result).toEqual({
				'webhook-signal': 101,
				'market-scanner': 202,
				'news-monitor': 303,
				default: 0,
			});
		});

		it('handles whitespace, newlines, semicolons, and equals signs', () => {
			const raw = '  webhook-signal = 101 ;\n market-scanner:202 ,\t default: 0 ';
			const result = parseTelegramTopicRoutes(raw);
			expect(result).toEqual({
				'webhook-signal': 101,
				'market-scanner': 202,
				default: 0,
			});
		});

		it('ignores malformed entries without throwing and logs a warning', () => {
			const mockLogger = { warn: jest.fn() };
			const raw = 'webhook-signal:101,invalid-entry,bad:abc,market-scanner:202';
			const result = parseTelegramTopicRoutes(raw, mockLogger);
			expect(result).toEqual({
				'webhook-signal': 101,
				'market-scanner': 202,
			});
			expect(mockLogger.warn).toHaveBeenCalledTimes(2);
		});

		it('normalizes object input', () => {
			const rawObj = {
				'webhook-signal': 101,
				'MARKET-SCANNER': '202',
				default: 0,
				invalid: 'abc',
			};
			const mockLogger = { warn: jest.fn() };
			const result = parseTelegramTopicRoutes(rawObj, mockLogger);
			expect(result).toEqual({
				'webhook-signal': 101,
				'market-scanner': 202,
				default: 0,
			});
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid'));
		});
	});

	describe('resolveTelegramThreadId', () => {
		const topicRoutes = {
			'webhook-signal': 101,
			'market-scanner': 202,
			'news-monitor': 303,
			'expanded-analysis': 404,
			default: 505,
		};

		it('gives highest precedence to explicit telegramThreadId override', () => {
			const alert = {
				source: 'webhook-signal',
				telegramThreadId: 999,
			};
			expect(resolveTelegramThreadId(alert, topicRoutes)).toBe(999);
		});

		it('supports numeric string for telegramThreadId override', () => {
			const alert = {
				source: 'webhook-signal',
				telegramThreadId: '999',
			};
			expect(resolveTelegramThreadId(alert, topicRoutes)).toBe(999);
		});

		it('returns null (general chat) when explicit telegramThreadId is 0 or "0"', () => {
			expect(resolveTelegramThreadId({ source: 'webhook-signal', telegramThreadId: 0 }, topicRoutes)).toBeNull();
			expect(resolveTelegramThreadId({ source: 'webhook-signal', telegramThreadId: '0' }, topicRoutes)).toBeNull();
		});

		it('supports alternative field names: messageThreadId, message_thread_id, telegram_thread_id', () => {
			expect(resolveTelegramThreadId({ messageThreadId: 777 }, topicRoutes)).toBe(777);
			expect(resolveTelegramThreadId({ message_thread_id: 888 }, topicRoutes)).toBe(888);
			expect(resolveTelegramThreadId({ telegram_thread_id: 999 }, topicRoutes)).toBe(999);
		});

		it('falls back to category matching when explicit override is invalid', () => {
			const mockLogger = { warn: jest.fn() };
			const alert = {
				source: 'webhook-signal',
				telegramThreadId: 'invalid-thread-id',
			};
			expect(resolveTelegramThreadId(alert, topicRoutes, mockLogger)).toBe(101);
			expect(mockLogger.warn).toHaveBeenCalled();
		});

		it('resolves exact match on alert.source', () => {
			expect(resolveTelegramThreadId({ source: 'webhook-signal' }, topicRoutes)).toBe(101);
			expect(resolveTelegramThreadId({ source: 'market-scanner' }, topicRoutes)).toBe(202);
			expect(resolveTelegramThreadId({ source: 'news-monitor' }, topicRoutes)).toBe(303);
			expect(resolveTelegramThreadId({ source: 'expanded-analysis' }, topicRoutes)).toBe(404);
		});

		it('resolves match across alias groups', () => {
			expect(resolveTelegramThreadId({ source: 'webhook-alert' }, topicRoutes)).toBe(101);
			expect(resolveTelegramThreadId({ source: 'signal' }, topicRoutes)).toBe(101);
			expect(resolveTelegramThreadId({ source: 'scanner' }, topicRoutes)).toBe(202);
			expect(resolveTelegramThreadId({ source: 'news' }, topicRoutes)).toBe(303);
			expect(resolveTelegramThreadId({ source: 'analysis' }, topicRoutes)).toBe(404);
		});

		it('resolves match on alert.category, alert.type, alert.setupType, alert.eventCategory', () => {
			expect(resolveTelegramThreadId({ category: 'market-scanner' }, topicRoutes)).toBe(202);
			expect(resolveTelegramThreadId({ type: 'market-scanner' }, topicRoutes)).toBe(202);
			expect(resolveTelegramThreadId({ setupType: 'webhook-signal' }, topicRoutes)).toBe(101);
			expect(resolveTelegramThreadId({ eventCategory: 'news-monitor' }, topicRoutes)).toBe(303);
		});

		it('falls back to default route when no category matches', () => {
			expect(resolveTelegramThreadId({ source: 'unmatched-source' }, topicRoutes)).toBe(505);
			expect(resolveTelegramThreadId({}, topicRoutes)).toBe(505);
		});

		it('returns null when default route is 0 (general chat)', () => {
			const routesWithZeroDefault = {
				'webhook-signal': 101,
				default: 0,
			};
			expect(resolveTelegramThreadId({ source: 'other' }, routesWithZeroDefault)).toBeNull();
		});

		it('supports wildcard * as default route key', () => {
			const routesWithWildcard = {
				'webhook-signal': 101,
				'*': 707,
			};
			expect(resolveTelegramThreadId({ source: 'other' }, routesWithWildcard)).toBe(707);
		});

		it('returns null when topicRoutes is empty or undefined', () => {
			expect(resolveTelegramThreadId({ source: 'webhook-signal' }, {})).toBeNull();
			expect(resolveTelegramThreadId({ source: 'webhook-signal' }, null)).toBeNull();
			expect(resolveTelegramThreadId({ source: 'webhook-signal' }, undefined)).toBeNull();
		});
	});
});
