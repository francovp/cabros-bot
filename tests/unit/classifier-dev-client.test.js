describe('classifier.dev client', () => {
	const originalFlag = process.env.ENABLE_NEWS_MONITOR_CLASSIFIER;
	const originalFetch = global.fetch;
	const labels = ['price_surge', 'price_decline', 'public_figure', 'regulatory', 'none'];

	afterEach(() => {
		if (originalFlag === undefined) delete process.env.ENABLE_NEWS_MONITOR_CLASSIFIER;
		else process.env.ENABLE_NEWS_MONITOR_CLASSIFIER = originalFlag;
		global.fetch = originalFetch;
		jest.resetModules();
	});

	it('does not call the provider unless explicitly enabled', async () => {
		delete process.env.ENABLE_NEWS_MONITOR_CLASSIFIER;
		global.fetch = jest.fn();
		const { classifyHeadline } = require('../../src/services/classifierDevClient');

		await expect(classifyHeadline('Market headline', { labels })).resolves.toBeNull();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('posts a bounded classification request and validates its result', async () => {
		process.env.ENABLE_NEWS_MONITOR_CLASSIFIER = 'true';
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: jest.fn().mockResolvedValue({ results: [{ label: 'price_surge', confidence: 0.91 }] }),
		});
		const { classifyHeadline } = require('../../src/services/classifierDevClient');

		await expect(classifyHeadline('Bitcoin rallies after earnings', {
			labels,
			instructions: 'Classify material financial events.',
		})).resolves.toEqual({ label: 'price_surge', confidence: 0.91 });

		const [url, request] = global.fetch.mock.calls[0];
		expect(url).toBe('https://classifier.dev/v1/classify');
		expect(request.method).toBe('POST');
		expect(request.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json' });
		expect(request.body).toBe(JSON.stringify({
			input: 'Bitcoin rallies after earnings',
			labels,
			instructions: 'Classify material financial events.',
			tier: 'fast',
		}));
		expect(request.signal).toBeInstanceOf(AbortSignal);
	});

	it('fails open for provider errors and malformed results', async () => {
		process.env.ENABLE_NEWS_MONITOR_CLASSIFIER = 'true';
		const { classifyHeadline } = require('../../src/services/classifierDevClient');
		global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });
		await expect(classifyHeadline('headline', { labels })).resolves.toBeNull();

		global.fetch.mockResolvedValue({
			ok: true,
			json: jest.fn().mockResolvedValue({ results: [{ label: 'unknown', confidence: 2 }] }),
		});
		await expect(classifyHeadline('headline', { labels })).resolves.toBeNull();
	});
});
