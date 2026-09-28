'use strict';

/**
 * tests/unit/whatsapp-template-service.test.js
 * Unit tests for WhatsAppService opt-in template mode (Issue #850)
 */

const WhatsAppService = require('../../src/services/notification/WhatsAppService');
const { getWhatsAppTemplateStatus } = require('../../src/services/notification/WhatsAppService');

const BASE_ENV = {
	ENABLE_WHATSAPP_ALERTS: 'true',
	WHATSAPP_API_URL: 'https://1234.api.green-api.com/waInstance9999/',
	WHATSAPP_API_KEY: 'test-api-key',
	WHATSAPP_CHAT_ID: '120363000000001@g.us',
	WHATSAPP_TEMPLATE_NAME: 'cabros_alert_v1',
	WHATSAPP_TEMPLATE_LANGUAGE: 'en',
};

function buildService(envOverrides = {}) {
	const savedEnv = {};
	const toSet = { ...BASE_ENV, ...envOverrides };
	for (const [k, v] of Object.entries(toSet)) {
		savedEnv[k] = process.env[k];
		if (v === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = v;
		}
	}
	const svc = new WhatsAppService({ logger: null });
	svc.enabled = true; // simulate validated
	return { svc, savedEnv, toSet };
}

function restoreEnv(savedEnv) {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = v;
		}
	}
}

afterEach(() => {
	jest.restoreAllMocks();
	global.fetch = undefined;
});

// ---------------------------------------------------------------------------
// _buildTemplateUrl
// ---------------------------------------------------------------------------
describe('WhatsAppService._buildTemplateUrl', () => {
	it('appends /sendTemplate/<apiKey> to base URL stripping /sendMessage suffix', () => {
		const { svc, savedEnv } = buildService({
			WHATSAPP_API_URL: 'https://1234.api.green-api.com/waInstance9999/sendMessage/',
		});
		const url = svc._buildTemplateUrl();
		expect(url).toBe('https://1234.api.green-api.com/waInstance9999/sendTemplate/test-api-key');
		restoreEnv(savedEnv);
	});

	it('works with base URL that has no /sendMessage suffix', () => {
		const { svc, savedEnv } = buildService({
			WHATSAPP_API_URL: 'https://1234.api.green-api.com/waInstance9999/',
		});
		const url = svc._buildTemplateUrl();
		expect(url).toBe('https://1234.api.green-api.com/waInstance9999/sendTemplate/test-api-key');
		restoreEnv(savedEnv);
	});

	it('returns null when apiUrl is not set', () => {
		const { svc, savedEnv } = buildService({ WHATSAPP_API_URL: undefined });
		svc.apiUrl = '';
		const url = svc._buildTemplateUrl();
		expect(url).toBeNull();
		restoreEnv(savedEnv);
	});
});

// ---------------------------------------------------------------------------
// _extractTemplateParams
// ---------------------------------------------------------------------------
describe('WhatsAppService._extractTemplateParams', () => {
	it('extracts symbol, price, action, setup, timeframe, source from alert.enriched', () => {
		const { svc, savedEnv } = buildService({});
		const alert = {
			enriched: {
				symbol: 'BTCUSDT',
				price: '45000',
				action: 'BUY',
				setupType: 'breakout',
				timeframe: '1h',
			},
			source: 'webhook',
		};
		const params = svc._extractTemplateParams(alert);
		expect(params).toEqual([
			{ default: 'BTCUSDT' },
			{ default: '45000' },
			{ default: 'BUY' },
			{ default: 'breakout' },
			{ default: '1h' },
			{ default: 'webhook' },
		]);
		restoreEnv(savedEnv);
	});

	it('produces empty strings for missing fields', () => {
		const { svc, savedEnv } = buildService({});
		const alert = { enriched: { symbol: 'ETH' }, source: '' };
		const params = svc._extractTemplateParams(alert);
		// price, action, setup, timeframe, source all missing → empty string
		expect(params[0]).toEqual({ default: 'ETH' });
		expect(params[1]).toEqual({ default: '' });
		expect(params[2]).toEqual({ default: '' });
		expect(params[3]).toEqual({ default: '' });
		restoreEnv(savedEnv);
	});

	it('respects WHATSAPP_TEMPLATE_PARAM_ORDER env override', () => {
		const { svc, savedEnv } = buildService({ WHATSAPP_TEMPLATE_PARAM_ORDER: 'source,action' });
		const alert = { enriched: { action: 'SELL' }, source: 'news-monitor' };
		const params = svc._extractTemplateParams(alert);
		expect(params).toHaveLength(2);
		expect(params[0]).toEqual({ default: 'news-monitor' });
		expect(params[1]).toEqual({ default: 'SELL' });
		restoreEnv(savedEnv);
	});

	it('handles null/undefined alert gracefully (never throws)', () => {
		const { svc, savedEnv } = buildService({});
		expect(() => svc._extractTemplateParams(null)).not.toThrow();
		expect(() => svc._extractTemplateParams(undefined)).not.toThrow();
		restoreEnv(savedEnv);
	});

	it('falls back to price regex match from text when enriched.price is absent', () => {
		const { svc, savedEnv } = buildService({ WHATSAPP_TEMPLATE_PARAM_ORDER: 'price' });
		const alert = { text: 'BTC reached $67,890.50', enriched: {} };
		const params = svc._extractTemplateParams(alert);
		expect(params[0].default).toBe('$67,890.50');
		restoreEnv(savedEnv);
	});
});

// ---------------------------------------------------------------------------
// _sendTemplate — success path
// ---------------------------------------------------------------------------
describe('WhatsAppService._sendTemplate — success', () => {
	it('calls GreenAPI /sendTemplate endpoint and returns success with idMessage', async () => {
		const { svc, savedEnv } = buildService({});
		const mockFetch = jest.fn().mockResolvedValue({
			ok: true,
			text: async () => JSON.stringify({ idMessage: 'tmpl-msg-abc' }),
		});
		global.fetch = mockFetch;

		const result = await svc._sendTemplate(
			{ enriched: { symbol: 'BTC', action: 'BUY' }, source: 'webhook' },
			'120363000000001@g.us',
			undefined,
		);

		expect(result.success).toBe(true);
		expect(result.templateSent).toBe(true);
		expect(result.messageId).toBe('tmpl-msg-abc');
		expect(svc._templateSent).toBe(1);

		// Verify the endpoint URL contains /sendTemplate/
		const [calledUrl, calledInit] = mockFetch.mock.calls[0];
		expect(calledUrl).toMatch(/\/sendTemplate\//);
		const body = JSON.parse(calledInit.body);
		expect(body.name).toBe('cabros_alert_v1');
		expect(body.languageCode).toBe('en');
		expect(Array.isArray(body.params)).toBe(true);
		restoreEnv(savedEnv);
	});

	it('treats 200 with empty body as success', async () => {
		const { svc, savedEnv } = buildService({});
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			text: async () => '',
		});
		const result = await svc._sendTemplate({ enriched: {} }, '120363@g.us', undefined);
		expect(result.success).toBe(true);
		expect(result.templateSent).toBe(true);
		restoreEnv(savedEnv);
	});

	it('includes namespace in payload when WHATSAPP_TEMPLATE_NAMESPACE is set', async () => {
		const { svc, savedEnv } = buildService({ WHATSAPP_TEMPLATE_NAMESPACE: 'my_ns' });
		const mockFetch = jest.fn().mockResolvedValue({
			ok: true,
			text: async () => JSON.stringify({ idMessage: 'tmpl-ns-1' }),
		});
		global.fetch = mockFetch;
		await svc._sendTemplate({ enriched: {} }, '120363@g.us', undefined);
		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.namespace).toBe('my_ns');
		restoreEnv(savedEnv);
	});
});

// ---------------------------------------------------------------------------
// _sendTemplate — fallback paths (4xx template-definition errors)
// ---------------------------------------------------------------------------
describe('WhatsAppService._sendTemplate — 4xx fallback errors', () => {
	const fallbackBodies = [
		'template not found',
		'Template Not Found',
		'parameter count mismatch',
		'invalid template',
		'template does not exist',
		'unknown template',
	];

	for (const body of fallbackBodies) {
		it(`sets shouldFallback=true and increments fallback counter for: "${body}"`, async () => {
			const { svc, savedEnv } = buildService({});
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 400,
				text: async () => body,
			});
			const result = await svc._sendTemplate({ enriched: {} }, '120363@g.us', undefined);
			expect(result.success).toBe(false);
			expect(result.shouldFallback).toBe(true);
			expect(svc._templateFallbacks).toBe(1);
			expect(svc._lastTemplateError).toBeTruthy();
			restoreEnv(savedEnv);
		});
	}

	it('does NOT set shouldFallback for 401 auth errors', async () => {
		const { svc, savedEnv } = buildService({});
		global.fetch = jest.fn().mockResolvedValue({
			ok: false,
			status: 401,
			text: async () => 'unauthorized',
		});
		const result = await svc._sendTemplate({ enriched: {} }, '120363@g.us', undefined);
		expect(result.success).toBe(false);
		expect(result.shouldFallback).toBeFalsy();
		expect(result.category).toBe('UNAUTHORIZED');
		restoreEnv(savedEnv);
	});

	it('does NOT set shouldFallback for 429 rate-limit errors', async () => {
		const { svc, savedEnv } = buildService({});
		global.fetch = jest.fn().mockResolvedValue({
			ok: false,
			status: 429,
			text: async () => 'too many requests',
		});
		const result = await svc._sendTemplate({ enriched: {} }, '120363@g.us', undefined);
		expect(result.success).toBe(false);
		expect(result.shouldFallback).toBeFalsy();
		expect(result.category).toBe('RATE_LIMITED');
		restoreEnv(savedEnv);
	});
});

// ---------------------------------------------------------------------------
// send() — template mode integration
// ---------------------------------------------------------------------------
describe('WhatsAppService.send() — template mode', () => {
	it('routes to _sendTemplate when options.template=true and WHATSAPP_TEMPLATE_NAME is set', async () => {
		const { svc, savedEnv } = buildService({});
		jest.spyOn(svc, '_sendTemplate').mockResolvedValue({
			success: true,
			channel: 'whatsapp',
			messageId: 'tmpl-123',
			templateSent: true,
		});

		const result = await svc.send({ text: 'BTC alert', enriched: {} }, { template: true });
		expect(svc._sendTemplate).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
		expect(result.templateSent).toBe(true);
		restoreEnv(savedEnv);
	});

	it('falls back to freeform when template returns shouldFallback=true', async () => {
		const { svc, savedEnv } = buildService({});
		jest.spyOn(svc, '_sendTemplate').mockResolvedValue({
			success: false,
			channel: 'whatsapp',
			error: 'template not found',
			shouldFallback: true,
		});
		jest.spyOn(svc, '_formatAlert').mockResolvedValue('BTC is at $45000');
		jest.spyOn(svc, '_sendMessageChunk').mockResolvedValue({
			success: true,
			channel: 'whatsapp',
			messageId: 'freeform-fallback-id',
			messageIds: ['freeform-fallback-id'],
			messageCount: 1,
		});

		const result = await svc.send({ text: 'BTC alert' }, { template: true });
		expect(svc._sendTemplate).toHaveBeenCalledTimes(1);
		expect(svc._sendMessageChunk).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
		expect(result.messageId).toBe('freeform-fallback-id');
		restoreEnv(savedEnv);
	});

	it('does NOT call _sendTemplate when options.template is not set', async () => {
		const { svc, savedEnv } = buildService({});
		jest.spyOn(svc, '_sendTemplate');
		jest.spyOn(svc, '_formatAlert').mockResolvedValue('BTC alert text');
		jest.spyOn(svc, '_sendMessageChunk').mockResolvedValue({
			success: true,
			channel: 'whatsapp',
			messageId: 'freeform-id',
			messageIds: ['freeform-id'],
			messageCount: 1,
		});

		await svc.send({ text: 'BTC alert' }, {});
		expect(svc._sendTemplate).not.toHaveBeenCalled();
		restoreEnv(savedEnv);
	});

	it('does NOT route to template when WHATSAPP_TEMPLATE_NAME is not set even with options.template=true', async () => {
		const { svc, savedEnv } = buildService({ WHATSAPP_TEMPLATE_NAME: undefined });
		delete process.env.WHATSAPP_TEMPLATE_NAME;
		jest.spyOn(svc, '_sendTemplate');
		jest.spyOn(svc, '_formatAlert').mockResolvedValue('BTC alert');
		jest.spyOn(svc, '_sendMessageChunk').mockResolvedValue({
			success: true,
			channel: 'whatsapp',
			messageId: 'freeform-id',
			messageIds: ['freeform-id'],
			messageCount: 1,
		});

		await svc.send({ text: 'BTC alert' }, { template: true });
		expect(svc._sendTemplate).not.toHaveBeenCalled();
		restoreEnv(savedEnv);
	});

	it('propagates abort signal early-exit without calling template', async () => {
		const { svc, savedEnv } = buildService({});
		const ctrl = new AbortController();
		ctrl.abort('test-abort');

		const result = await svc.send({ text: 'alert' }, { signal: ctrl.signal, template: true });
		expect(result.success).toBe(false);
		expect(result.aborted).toBe(true);
		restoreEnv(savedEnv);
	});
});

// ---------------------------------------------------------------------------
// getWhatsAppTemplateStatus (module-level helper)
// ---------------------------------------------------------------------------
describe('getWhatsAppTemplateStatus', () => {
	it('returns enabled=true, templateName, and languageCode when WHATSAPP_TEMPLATE_NAME is set', () => {
		const orig = process.env.WHATSAPP_TEMPLATE_NAME;
		const origLang = process.env.WHATSAPP_TEMPLATE_LANGUAGE;
		process.env.WHATSAPP_TEMPLATE_NAME = 'cabros_v2';
		process.env.WHATSAPP_TEMPLATE_LANGUAGE = 'es';

		const status = getWhatsAppTemplateStatus();
		expect(status).toEqual({ enabled: true, templateName: 'cabros_v2', languageCode: 'es' });

		process.env.WHATSAPP_TEMPLATE_NAME = orig ?? '';
		if (origLang !== undefined) process.env.WHATSAPP_TEMPLATE_LANGUAGE = origLang;
	});

	it('returns enabled=false and null values when WHATSAPP_TEMPLATE_NAME is not set', () => {
		const orig = process.env.WHATSAPP_TEMPLATE_NAME;
		delete process.env.WHATSAPP_TEMPLATE_NAME;

		const status = getWhatsAppTemplateStatus();
		expect(status.enabled).toBe(false);
		expect(status.templateName).toBeNull();
		expect(status.languageCode).toBeNull();

		if (orig !== undefined) process.env.WHATSAPP_TEMPLATE_NAME = orig;
	});

	it('defaults languageCode to "en" when WHATSAPP_TEMPLATE_LANGUAGE is not set', () => {
		const origName = process.env.WHATSAPP_TEMPLATE_NAME;
		const origLang = process.env.WHATSAPP_TEMPLATE_LANGUAGE;
		process.env.WHATSAPP_TEMPLATE_NAME = 'my_template';
		delete process.env.WHATSAPP_TEMPLATE_LANGUAGE;

		const status = getWhatsAppTemplateStatus();
		expect(status.languageCode).toBe('en');

		if (origName !== undefined) process.env.WHATSAPP_TEMPLATE_NAME = origName;
		if (origLang !== undefined) process.env.WHATSAPP_TEMPLATE_LANGUAGE = origLang;
	});
});

// ---------------------------------------------------------------------------
// Secret sanitization — templateName must not leak apiKey
// ---------------------------------------------------------------------------
describe('WhatsAppService._sanitizeText (template error body)', () => {
	it('redacts apiKey from template error body', () => {
		const { svc, savedEnv } = buildService({});
		const sensitive = `error: bad request, key=test-api-key, template not found`;
		const sanitized = svc._sanitizeText(sensitive);
		expect(sanitized).not.toContain('test-api-key');
		expect(sanitized).toContain('[REDACTED]');
		restoreEnv(savedEnv);
	});
});
