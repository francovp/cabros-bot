const {
	McpToolInventory,
	STATIC_FALLBACK_CATALOG,
	WIRED_TOOLS,
} = require('../../src/services/tradingview/mcpToolInventory');

function buildSseBody(payload) {
	return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function buildJsonBody(payload) {
	return JSON.stringify(payload);
}

describe('McpToolInventory', () => {
	it('exposes the static fallback catalog when no discovery has occurred', async () => {
		const inventory = new McpToolInventory({
			url: 'https://example.test/mcp',
			now: () => 1700000000000,
			logger: { warn: jest.fn() },
		});

		const snapshot = await inventory.snapshot({ discover: false });

		expect(snapshot.discovered).toEqual(STATIC_FALLBACK_CATALOG.slice());
		expect(snapshot.discoveredSource).toBe('fallback-static-catalog');
		expect(snapshot.discoveredAt).toBe('2023-11-14T22:13:20.000Z');
		for (const wired of WIRED_TOOLS) {
			expect(snapshot.wired[wired.name]).toEqual(expect.objectContaining({
				wired: true,
				callers: wired.callers,
				lastSuccessAt: null,
				lastFailureAt: null,
				lastCategory: null,
			}));
		}
	});

	it('reports discovered tool names via tools/list and merges the wired catalog', async () => {
		const upstreamTools = [
			{ name: 'coin_analysis' },
			{ name: 'combined_analysis' },
			{ name: 'multi_timeframe_analysis' },
			{ name: 'volume_confirmation_analysis' },
			{ name: 'top_gainers' },
			{ name: 'top_losers' },
			{ name: 'volume_breakout_scanner' },
			{ name: 'smart_volume_scanner' },
			{ name: 'bollinger_scan' },
			{ name: 'multi_agent_analysis' },
			{ name: 'advanced_candle_pattern' },
		];

		const fetchMock = jest
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: { get: name => (name === 'mcp-session-id' ? 'session-1' : null) },
				text: async () => buildSseBody({ jsonrpc: '2.0', id: 'discover-initialize-1', result: { protocolVersion: '2024-11-05' } }),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 202,
				headers: { get: () => null },
				text: async () => '',
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: { get: name => (name === 'content-type' ? 'text/event-stream' : null) },
				text: async () => buildSseBody({
					jsonrpc: '2.0',
					id: 'discover-list-1',
					result: { tools: upstreamTools },
				}),
			});

		const inventory = new McpToolInventory({
			url: 'https://example.test/mcp',
			fetchImpl: fetchMock,
			now: () => 1700000000000,
			logger: { warn: jest.fn() },
		});

		const snapshot = await inventory.snapshot();

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(snapshot.discoveredSource).toBe('tools/list');
		expect(snapshot.discovered).toEqual(upstreamTools.map(tool => tool.name));
		expect(snapshot.wired.coin_analysis).toEqual(expect.objectContaining({
			wired: true,
			callers: ['enrichFromSignal', 'alert/grounding'],
		}));
		expect(snapshot.wired.top_gainers).toEqual(expect.objectContaining({
			wired: true,
			callers: ['marketScanner'],
		}));
		expect(snapshot.wired.multi_agent_analysis).toEqual(expect.objectContaining({ wired: false }));
		expect(snapshot.wired.advanced_candle_pattern).toEqual(expect.objectContaining({ wired: false }));
		expect(snapshot.wired.backtest_strategy).toBeUndefined();
	});

	it('records success and failure telemetry per wired tool', async () => {
		const inventory = new McpToolInventory({
			url: 'https://example.test/mcp',
			now: () => 1700000000000,
			logger: { warn: jest.fn() },
		});

		inventory.recordCall('coin_analysis', { ok: true });
		inventory.recordCall('coin_analysis', { ok: false, category: 'http_5xx' });

		const snapshot = await inventory.snapshot({ discover: false });
		expect(snapshot.wired.coin_analysis.lastSuccessAt).toBe('2023-11-14T22:13:20.000Z');
		expect(snapshot.wired.coin_analysis.lastFailureAt).toBe('2023-11-14T22:13:20.000Z');
		expect(snapshot.wired.coin_analysis.lastCategory).toBe('http_5xx');
		expect(snapshot.wired.volume_confirmation_analysis.lastSuccessAt).toBeNull();
	});

	it('falls back to the static catalog when tools/list returns an empty result', async () => {
		const fetchMock = jest
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: { get: name => (name === 'mcp-session-id' ? 'session-1' : null) },
				text: async () => buildSseBody({ jsonrpc: '2.0', id: 'discover-initialize-1', result: { protocolVersion: '2024-11-05' } }),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 202,
				headers: { get: () => null },
				text: async () => '',
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: { get: name => (name === 'content-type' ? 'text/event-stream' : null) },
				text: async () => buildSseBody({ jsonrpc: '2.0', id: 'discover-list-1', result: { tools: [] } }),
			});

		const logger = { warn: jest.fn() };
		const inventory = new McpToolInventory({
			url: 'https://example.test/mcp',
			fetchImpl: fetchMock,
			now: () => 1700000000000,
			logger,
		});

		const snapshot = await inventory.snapshot();

		expect(snapshot.discoveredSource).toBe('fallback-static-catalog');
		expect(snapshot.discovered).toEqual(STATIC_FALLBACK_CATALOG.slice());
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tools/list discovery failed'));
	});

	it('falls back to the static catalog when the network request fails', async () => {
		const fetchMock = jest
			.fn()
			.mockRejectedValueOnce(new Error('ECONNREFUSED'));

		const logger = { warn: jest.fn() };
		const inventory = new McpToolInventory({
			url: 'https://example.test/mcp',
			fetchImpl: fetchMock,
			now: () => 1700000000000,
			logger,
		});

		const snapshot = await inventory.snapshot();

		expect(snapshot.discoveredSource).toBe('fallback-static-catalog');
		expect(snapshot.discovered).toEqual(STATIC_FALLBACK_CATALOG.slice());
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
	});

	it('caches the discovery result until the TTL elapses', async () => {
		let currentTime = 1700000000000;
		const buildInitResponse = () => ({
			ok: true,
			status: 200,
			headers: { get: name => (name === 'mcp-session-id' ? 'session-1' : null) },
			text: async () => buildSseBody({ jsonrpc: '2.0', id: 'discover-initialize-1', result: { protocolVersion: '2024-11-05' } }),
		});
		const buildNotifyResponse = () => ({
			ok: true,
			status: 202,
			headers: { get: () => null },
			text: async () => '',
		});
		const buildListResponse = () => ({
			ok: true,
			status: 200,
			headers: { get: name => (name === 'content-type' ? 'text/event-stream' : null) },
			text: async () => buildSseBody({ jsonrpc: '2.0', id: 'discover-list-1', result: { tools: [{ name: 'coin_analysis' }, { name: 'top_gainers' }] } }),
		});

		const fetchMock = jest.fn()
			.mockImplementationOnce(buildInitResponse)
			.mockImplementationOnce(buildNotifyResponse)
			.mockImplementationOnce(buildListResponse)
			.mockImplementationOnce(buildInitResponse)
			.mockImplementationOnce(buildNotifyResponse)
			.mockImplementationOnce(buildListResponse);

		const inventory = new McpToolInventory({
			url: 'https://example.test/mcp',
			fetchImpl: fetchMock,
			now: () => currentTime,
			discoveryTtlMs: 60000,
			logger: { warn: jest.fn() },
		});

		await inventory.snapshot();
		const second = await inventory.snapshot();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(second.discoveredSource).toBe('tools/list');

		currentTime += 120000;
		await inventory.snapshot();
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it('ignores invalid or non-string tool names without throwing', () => {
		const inventory = new McpToolInventory({
			url: 'https://example.test/mcp',
			now: () => 1700000000000,
			logger: { warn: jest.fn() },
		});

		expect(() => inventory.recordCall(null, { ok: true })).not.toThrow();
		expect(() => inventory.recordCall('', { ok: false, category: 'timeout' })).not.toThrow();
		expect(() => inventory.recordCall(42, { ok: true })).not.toThrow();
	});
});