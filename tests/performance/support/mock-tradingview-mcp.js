'use strict';

const express = require('express');
const http = require('node:http');

function createToolResult(toolName, args = {}) {
	if (toolName === 'coin_analysis') {
		return {
			symbol: `${args.exchange || 'BINANCE'}:${args.symbol || 'BTCUSDT'}`,
			price_data: {
				current_price: 65000,
				change_percent: 1.25,
				volume: 1000000,
				high: 66000,
				low: 64000,
			},
			technical_indicators: {
				rsi: 55,
				sma20: 64500,
				macd: 12,
				macd_signal: 10,
				atr: 500,
			},
		};
	}

	// Scanner tools accept an empty result set as a successful scan.
	return [];
}

async function startMockTradingViewMcp() {
	const app = express();
	app.use(express.json({ limit: '64kb' }));
	app.post('/mcp', (req, res) => {
		const rpc = req.body || {};
		if (rpc.method === 'initialize') {
			return res
				.set('mcp-session-id', 'performance-test-session')
				.status(200)
				.json({
					jsonrpc: '2.0',
					id: rpc.id,
					result: {
						protocolVersion: '2024-11-05',
						capabilities: { tools: {} },
						serverInfo: { name: 'performance-test-mcp', version: '1.0.0' },
					},
				});
		}

		if (rpc.method === 'notifications/initialized') {
			return res.status(202).end();
		}

		if (rpc.method === 'tools/call') {
			return res.status(200).json({
				jsonrpc: '2.0',
				id: rpc.id,
				result: { structuredContent: createToolResult(rpc.params?.name, rpc.params?.arguments) },
			});
		}

		return res.status(400).json({
			jsonrpc: '2.0',
			id: rpc.id || null,
			error: { code: -32601, message: 'Unsupported performance MCP request' },
		});
	});

	const server = http.createServer(app);
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address();

	return {
		url: `http://127.0.0.1:${port}/mcp`,
		close: () => new Promise((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		}),
	};
}

module.exports = { startMockTradingViewMcp };
