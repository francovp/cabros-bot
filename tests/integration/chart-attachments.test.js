'use strict';

const { resetChartRendererService, getChartRendererService } = require('../../src/services/notification/charts/chartRenderer');
const TelegramService = require('../../src/services/notification/TelegramService');
const WhatsAppService = require('../../src/services/notification/WhatsAppService');
const DiscordService = require('../../src/services/notification/DiscordService');
const statusController = require('../../src/controllers/status');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeBars(count, step = 1) {
	const bars = [];
	for (let i = 0; i < count; i += 1) {
		const open = 100 + i * step;
		const close = open + step / 2;
		bars.push({
			open,
			high: Math.max(open, close) + 0.4,
			low: Math.min(open, close) - 0.4,
			close,
			volume: 1000 + i,
		});
	}
	return bars;
}

function makeTelegramService(callApi) {
	const bot = { telegram: { callApi, sendMessage: callApi } };
	return new TelegramService({
		bot,
		chatId: 'chat-1',
		maxMessageLength: 4000,
		formatter: { format: (text) => text, formatEnriched: (enriched) => JSON.stringify(enriched) },
	});
}

/**
 * Toggle the feature flag for the duration of an async body.
 *
 * The flag must stay set until the body settles: the chart renderer reads
 * `ENABLE_CHART_ATTACHMENTS` when the process-wide singleton is constructed, so
 * restoring it early silently disables charts mid-assertion.
 */
async function withChartFlag(enabled, fn) {
	const previous = process.env.ENABLE_CHART_ATTACHMENTS;
	if (enabled) process.env.ENABLE_CHART_ATTACHMENTS = 'true';
	else delete process.env.ENABLE_CHART_ATTACHMENTS;
	resetChartRendererService();
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.ENABLE_CHART_ATTACHMENTS;
		else process.env.ENABLE_CHART_ATTACHMENTS = previous;
		resetChartRendererService();
	}
}

describe('chart attachments — flag off preserves existing behaviour', () => {
	afterEach(() => { resetChartRendererService(); });

	it('sends no photo and uses the text-only path when the flag is off', async () => {
		await withChartFlag(false, async () => {
			const callApi = jest.fn().mockResolvedValue({ message_id: 7 });
			const service = makeTelegramService(callApi);

			const result = await service.send({ text: 'BTC breakout', symbol: 'BTCUSDT', chartBars: makeBars(6) });

			expect(result.success).toBe(true);
			expect(callApi).toHaveBeenCalledTimes(1);
			expect(callApi.mock.calls[0][0]).toBe('sendMessage');
		});
	});

	it('reports chartAttachments=false and a disabled renderer in status', async () => {
		await withChartFlag(false, async () => {
			const payload = await statusController.getStatus();
			expect(payload.featureFlags.chartAttachments).toBe(false);
			expect(payload.dependencies.chartRenderer.enabled).toBe(false);
		});
	});
});

describe('chart attachments — Telegram photo delivery', () => {
	afterEach(() => { resetChartRendererService(); });

	it('attaches a PNG photo with the report as caption', async () => {
		await withChartFlag(true, async () => {
			const callApi = jest.fn().mockResolvedValue({ message_id: 55 });
			const service = makeTelegramService(callApi);

			const result = await service.send({
				text: 'BTC breakout', symbol: 'BTCUSDT', chartBars: makeBars(6),
			});

			expect(result.success).toBe(true);
			expect(callApi).toHaveBeenCalledTimes(1);
			const [method, payload] = callApi.mock.calls[0];
			expect(method).toBe('sendPhoto');
			expect(Buffer.isBuffer(payload.photo)).toBe(true);
			expect(payload.photo.subarray(0, 8)).toEqual(PNG_MAGIC);
			expect(payload.caption).toContain('BTC breakout');
			expect(payload.parse_mode).toBe('MarkdownV2');
			expect(payload.chat_id).toBe('chat-1');
		});
	});

	it('sends long reports as the caption plus follow-up text messages', async () => {
		await withChartFlag(true, async () => {
			let nextId = 1;
			const callApi = jest.fn().mockImplementation(async () => ({ message_id: nextId++ }));
			const service = new TelegramService({
				bot: { telegram: { callApi } },
				chatId: 'chat-1',
				maxMessageLength: 50,
				formatter: { format: (text) => text },
			});

			const result = await service.send({
				text: 'X'.repeat(300), symbol: 'BTCUSDT', chartBars: makeBars(6),
			});

			expect(result.success).toBe(true);
			expect(callApi.mock.calls[0][0]).toBe('sendPhoto');
			expect(callApi.mock.calls[0][1].caption.length).toBeLessThanOrEqual(50);
			const followUps = callApi.mock.calls.filter((call) => call[0] === 'sendMessage');
			expect(followUps.length).toBeGreaterThan(0);
			followUps.forEach((call) => {
				expect(call[1].text.length).toBeLessThanOrEqual(50);
			});
		});
	});

	it('reuses the cached buffer on a repeated identical signal', async () => {
		await withChartFlag(true, async () => {
			const callApi = jest.fn()
				.mockResolvedValueOnce({ message_id: 1 })
				.mockResolvedValueOnce({ message_id: 2 });
			const service = makeTelegramService(callApi);
			const alert = { text: 'BTC', symbol: 'BTCUSDT', chartBars: makeBars(6), timeframe: '1h' };

			await service.send(alert);
			await service.send({ ...alert });

			expect(callApi.mock.calls[0][1].photo).toBe(callApi.mock.calls[1][1].photo);
		});
	});

	it('falls back to the plain-text caption when MarkdownV2 parsing fails', async () => {
		await withChartFlag(true, async () => {
			const parseError = new Error("Bad Request: can't parse entities");
			const callApi = jest.fn()
				.mockRejectedValueOnce(parseError)
				.mockResolvedValueOnce({ message_id: 9 });
			const service = makeTelegramService(callApi);

			const result = await service.send({
				text: 'a_b*c', symbol: 'BTCUSDT', chartBars: makeBars(6),
			});

			expect(result.success).toBe(true);
			// One rejected MarkdownV2 attempt plus one plain-text retry, and no
			// leftover text message once the photo carries the report.
			expect(callApi).toHaveBeenCalledTimes(2);
			expect(callApi.mock.calls[0][1].parse_mode).toBe('MarkdownV2');
			expect(callApi.mock.calls[1][1].parse_mode).toBeUndefined();
			expect(callApi.mock.calls[1][1].caption).toBe('a_b*c');
		});
	});

	it('falls back to text-only delivery when the photo call fails', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		await withChartFlag(true, async () => {
			const callApi = jest.fn()
				.mockRejectedValueOnce(new Error('photo rejected'))
				.mockResolvedValueOnce({ message_id: 3 });
			const service = makeTelegramService(callApi);

			const result = await service.send({
				text: 'BTC breakout', symbol: 'BTCUSDT', chartBars: makeBars(6),
			});

			expect(result.success).toBe(true);
			expect(callApi.mock.calls.map((call) => call[0])).toEqual(['sendPhoto', 'sendMessage']);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('photo delivery failed'),
				expect.anything(),
			);
		});
		warn.mockRestore();
	});

	it('preserves forum topic routing on the photo payload', async () => {
		await withChartFlag(true, async () => {
			const callApi = jest.fn().mockResolvedValue({ message_id: 4 });
			const service = makeTelegramService(callApi);

			await service.send({
				text: 'BTC', symbol: 'BTCUSDT', chartBars: makeBars(6),
				source: 'market-scanner', telegramThreadId: 42,
			});

			expect(callApi.mock.calls[0][1].message_thread_id).toBe(42);
		});
	});

	it('does not attach a photo when the alert has no chart bars', async () => {
		await withChartFlag(true, async () => {
			const callApi = jest.fn().mockResolvedValue({ message_id: 5 });
			const service = makeTelegramService(callApi);

			await service.send({ text: 'plain alert', symbol: 'BTCUSDT' });

			expect(callApi).toHaveBeenCalledTimes(1);
			expect(callApi.mock.calls[0][0]).toBe('sendMessage');
		});
	});
});

describe('chart attachments — WhatsApp upload', () => {
	afterEach(() => { resetChartRendererService(); });

	function makeWhatsAppService() {
		return new WhatsAppService({
			apiUrl: 'https://api.greenapi.com/waInstance123/sendMessage/',
			apiKey: 'test-key',
			chatId: '1203630000@g.us',
			formatter: { format: (text) => text, formatEnriched: (e) => JSON.stringify(e) },
		});
	}

	it('uploads the chart as a file with the report as caption', async () => {
		await withChartFlag(true, async () => {
			const fetchMock = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ idFile: 'file-1' }),
				text: async () => '',
			});
			global.fetch = fetchMock;
			const service = makeWhatsAppService();

			const result = await service.send({
				text: 'BTC breakout', symbol: 'BTCUSDT', chartBars: makeBars(6),
			});

			expect(result.success).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('https://api.greenapi.com/waInstance123/sendFileByUpload/test-key');
			expect(init.body).toBeInstanceOf(FormData);
			expect(init.body.get('file')).toBeInstanceOf(Blob);
		});
	});

	it('falls back to the text message when the upload fails', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		await withChartFlag(true, async () => {
			const fetchMock = jest.fn()
				.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
				.mockResolvedValueOnce({ ok: true, json: async () => ({ idMessage: 'm-1' }), text: async () => '' });
			global.fetch = fetchMock;
			const service = makeWhatsAppService();

			const result = await service.send({
				text: 'BTC breakout', symbol: 'BTCUSDT', chartBars: makeBars(6),
			});

			expect(result.success).toBe(true);
			expect(fetchMock.mock.calls[0][0]).toContain('sendFileByUpload');
			expect(fetchMock.mock.calls[1][0]).toContain('sendMessage');
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('file upload failed'),
				expect.anything(),
			);
		});
		warn.mockRestore();
	});

	it('makes no upload call when the flag is off', async () => {
		await withChartFlag(false, async () => {
			const fetchMock = jest.fn().mockResolvedValue({
				ok: true, json: async () => ({ idMessage: 'm-2' }), text: async () => '',
			});
			global.fetch = fetchMock;
			const service = makeWhatsAppService();

			await service.send({ text: 'BTC breakout', symbol: 'BTCUSDT', chartBars: makeBars(6) });

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock.mock.calls[0][0]).toContain('sendMessage');
		});
	});
});

describe('chart attachments — Discord documented text fallback', () => {
	afterEach(() => { resetChartRendererService(); });

	it('logs the skip and still delivers text', async () => {
		await withChartFlag(true, async () => {
			const fetchMock = jest.fn().mockResolvedValue({
				ok: true, status: 204, json: async () => ({}), text: async () => '',
			});
			global.fetch = fetchMock;
			const debugLog = jest.fn();
			const service = new DiscordService({
				webhookUrl: 'https://discord.com/api/webhooks/1/abc',
				formatter: { format: (text) => text, formatEnriched: (e) => JSON.stringify(e) },
				logger: { debug: debugLog, warn: jest.fn(), error: jest.fn() },
			});

			const result = await service.send({
				text: 'BTC breakout', symbol: 'BTCUSDT', chartBars: makeBars(6),
			});

			expect(result.success).toBe(true);
			expect(debugLog).toHaveBeenCalledWith(
				expect.stringContaining('chart attachment skipped: discord'),
			);
			// The webhook body stays plain text — no embed image is invented.
			const body = JSON.parse(fetchMock.mock.calls[0][1].body);
			expect(body.embeds?.[0]?.image).toBeUndefined();
		});
	});
});

describe('chart attachments — renderer failure keeps text-only delivery', () => {
	afterEach(() => { resetChartRendererService(); });

	it('warns and delivers text when the renderer throws', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		await withChartFlag(true, async () => {
			// Break the shared singleton the channels actually resolve, so the
			// failure travels the real delivery path.
			const renderer = getChartRendererService();
			jest.spyOn(renderer, '_drawChart').mockImplementation(() => { throw new Error('render boom'); });

			const callApi = jest.fn().mockResolvedValue({ message_id: 8 });
			const service = makeTelegramService(callApi);

			const result = await service.send({
				text: 'BTC breakout', symbol: 'BTCUSDT', chartBars: makeBars(6),
			});

			expect(result.success).toBe(true);
			expect(callApi).toHaveBeenCalledTimes(1);
			expect(callApi.mock.calls[0][0]).toBe('sendMessage');
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('falling back to text-only delivery'),
				expect.anything(),
			);
		});
		warn.mockRestore();
	});
});
