/* global fetch, AbortController */

/**
 * TradingView MCP tool inventory + telemetry recorder.
 *
 * The repository wires a bounded set of MCP tools (`callCoinAnalysis`,
 * `callCombinedAnalysis`, `callMultiTimeframeAnalysis`,
 * `callVolumeConfirmation`, and the four scanner lanes via `callScanTool`).
 * Operators also need to know which upstream tools are advertised but
 * unwired, plus the most recent success/failure for each wired tool.
 *
 * `McpToolInventory` is a process-local, fail-open helper that:
 *   - Caches the upstream `tools/list` discovery with a bounded TTL.
 *   - Falls back to a static catalog when the upstream call fails, returns
 *     an empty list, or times out.
 *   - Records per-tool call outcomes (success / failure with category) and
 *     exposes `lastSuccessAt` / `lastFailureAt` / `lastCategory`.
 *   - Exposes a `wired` map that joins the static caller catalog with the
 *     runtime discovery so a tool that is unwired is still listed when the
 *     upstream advertises it.
 *
 * No secrets, provider URLs, or raw payloads are exposed through the
 * returned object. The catalog and telemetry are safe for inclusion under
 * `dependencies.tradingViewMcp.mcpTools` in `/api/status` and
 * `/api/capabilities`.
 */

const STATIC_FALLBACK_CATALOG = Object.freeze([
	'coin_analysis',
	'combined_analysis',
	'multi_timeframe_analysis',
	'volume_confirmation_analysis',
	'top_gainers',
	'top_losers',
	'volume_breakout_scanner',
	'smart_volume_scanner',
	'bollinger_scan',
	'backtest_strategy',
	'compare_strategies',
	'walk_forward_backtest_strategy',
	'multi_agent_analysis',
	'market_snapshot',
	'rating_filter',
	'consecutive_candles_scan',
	'advanced_candle_pattern',
]);

const DEFAULT_DISCOVERY_TTL_MS = 60 * 60 * 1000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 8000;

const WIRED_TOOLS = Object.freeze([
	Object.freeze({ name: 'coin_analysis', callers: Object.freeze(['enrichFromSignal', 'alert/grounding']) }),
	Object.freeze({ name: 'combined_analysis', callers: Object.freeze(['enrichFromSignal']) }),
	Object.freeze({ name: 'multi_timeframe_analysis', callers: Object.freeze(['enrichFromSignal']) }),
	Object.freeze({ name: 'volume_confirmation_analysis', callers: Object.freeze(['enrichFromSignal']) }),
	Object.freeze({ name: 'top_gainers', callers: Object.freeze(['marketScanner']) }),
	Object.freeze({ name: 'top_losers', callers: Object.freeze(['marketScanner']) }),
	Object.freeze({ name: 'volume_breakout_scanner', callers: Object.freeze(['marketScanner']) }),
	Object.freeze({ name: 'smart_volume_scanner', callers: Object.freeze(['marketScanner']) }),
	Object.freeze({ name: 'bollinger_scan', callers: Object.freeze(['marketScanner']) }),
]);

const WIRED_TOOL_NAMES = new Set(WIRED_TOOLS.map(entry => entry.name));

function sanitizeToolName(value) {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function extractToolNamesFromListResponse(payload) {
	if (!payload || typeof payload !== 'object') {
		return [];
	}
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const names = tools
		.map(entry => (entry && typeof entry === 'object' ? sanitizeToolName(entry.name) : null))
		.filter(Boolean);
	return names;
}

class McpToolInventory {
	constructor({
		url,
		fetchImpl = (typeof fetch === 'function' ? fetch : null),
		now = () => Date.now(),
		logger = console,
		discoveryTtlMs = DEFAULT_DISCOVERY_TTL_MS,
		discoveryTimeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
		fallbackCatalog = STATIC_FALLBACK_CATALOG,
		wiredCatalog = WIRED_TOOLS,
	} = {}) {
		this._url = url || null;
		this._fetch = fetchImpl;
		this._now = now;
		this._logger = logger;
		this._discoveryTtlMs = discoveryTtlMs > 0 ? discoveryTtlMs : DEFAULT_DISCOVERY_TTL_MS;
		this._discoveryTimeoutMs = discoveryTimeoutMs > 0 ? discoveryTimeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS;
		this._fallbackCatalog = Array.isArray(fallbackCatalog) ? fallbackCatalog.slice() : STATIC_FALLBACK_CATALOG.slice();
		this._wiredCatalog = Array.isArray(wiredCatalog) ? wiredCatalog : WIRED_TOOLS;

		this._discoveredNames = null;
		this._discoveredAt = null;
		this._discoveredSource = null;
		this._discoverInFlight = null;
		this._discoverLastError = null;

		this._telemetry = new Map();
		this._initTelemetry();
	}

	_initTelemetry() {
		for (const entry of this._wiredCatalog) {
			this._telemetry.set(entry.name, {
				lastSuccessAt: null,
				lastFailureAt: null,
				lastCategory: null,
			});
		}
	}

	setUrl(url) {
		const next = typeof url === 'string' && url.trim().length > 0 ? url.trim() : null;
		if (next !== this._url) {
			this._url = next;
			this._discoveredNames = null;
			this._discoveredAt = null;
			this._discoveredSource = null;
			this._discoverInFlight = null;
		}
	}

	getWiredCatalog() {
		return this._wiredCatalog.map(entry => ({
			name: entry.name,
			callers: Array.isArray(entry.callers) ? entry.callers.slice() : [],
		}));
	}

	getFallbackCatalog() {
		return this._fallbackCatalog.slice();
	}

	recordCall(toolName, { ok = false, category = null } = {}) {
		const name = sanitizeToolName(toolName);
		if (!name) {
			return;
		}
		const entry = this._telemetry.get(name) || {
			lastSuccessAt: null,
			lastFailureAt: null,
			lastCategory: null,
		};
		const timestamp = new Date(this._now()).toISOString();
		if (ok) {
			entry.lastSuccessAt = timestamp;
			entry.lastCategory = category || null;
		} else {
			entry.lastFailureAt = timestamp;
			entry.lastCategory = category || null;
		}
		this._telemetry.set(name, entry);
	}

	_getCachedDiscovery() {
		if (!this._discoveredNames || !this._discoveredAt) {
			return null;
		}
		const age = this._now() - this._discoveredAt;
		if (age >= this._discoveryTtlMs) {
			return null;
		}
		return {
			names: this._discoveredNames.slice(),
			discoveredAt: new Date(this._discoveredAt).toISOString(),
			source: this._discoveredSource,
		};
	}

	_discoverFromUpstream() {
		if (!this._url || typeof this._fetch !== 'function') {
			return Promise.resolve([]);
		}
		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			controller.abort(new Error(`TradingView MCP tools/list discovery timeout after ${this._discoveryTimeoutMs}ms`));
		}, this._discoveryTimeoutMs);
		const initializeRequest = {
			jsonrpc: '2.0',
			id: `discover-initialize-${this._now()}`,
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: {
					name: 'cabros-bot',
					version: '0.1.0',
				},
			},
		};
		const headers = {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream, application/json',
		};

		return (async () => {
			let initResponse;
			try {
				initResponse = await this._fetch(this._url, {
					method: 'POST',
					headers,
					body: JSON.stringify(initializeRequest),
					signal: controller.signal,
				});
			} catch (error) {
				throw new Error(`TradingView MCP tools/list discovery request failed: ${error.message}`);
			} finally {
				clearTimeout(timeoutId);
			}

			if (!initResponse || !initResponse.ok) {
				throw new Error(`TradingView MCP tools/list discovery HTTP ${initResponse ? initResponse.status : 'unknown'}`);
			}

			const sessionId = initResponse.headers && typeof initResponse.headers.get === 'function'
				? initResponse.headers.get('mcp-session-id')
				: null;
			if (!sessionId) {
				throw new Error('TradingView MCP tools/list discovery missing mcp-session-id header');
			}

			const notifyController = new AbortController();
			const notifyTimeoutId = setTimeout(() => {
				notifyController.abort(new Error(`TradingView MCP tools/list notify timeout after ${this._discoveryTimeoutMs}ms`));
			}, this._discoveryTimeoutMs);
			try {
				await this._fetch(this._url, {
					method: 'POST',
					headers: {
						...headers,
						'mcp-session-id': sessionId,
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						method: 'notifications/initialized',
						params: {},
					}),
					signal: notifyController.signal,
				});
			} catch {
				// Notifications are fire-and-forget; ignore.
			} finally {
				clearTimeout(notifyTimeoutId);
			}

			const listController = new AbortController();
			const listTimeoutId = setTimeout(() => {
				listController.abort(new Error(`TradingView MCP tools/list list timeout after ${this._discoveryTimeoutMs}ms`));
			}, this._discoveryTimeoutMs);
			const listRequestId = `discover-list-${this._now()}`;
			let listResponse;
			let bodyText;
			try {
				listResponse = await this._fetch(this._url, {
					method: 'POST',
					headers: {
						...headers,
						'mcp-session-id': sessionId,
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: listRequestId,
						method: 'tools/list',
						params: {},
					}),
					signal: listController.signal,
				});
				bodyText = await listResponse.text();
			} catch (error) {
				throw new Error(`TradingView MCP tools/list list request failed: ${error.message}`);
			} finally {
				clearTimeout(listTimeoutId);
			}

			if (!listResponse || !listResponse.ok) {
				throw new Error(`TradingView MCP tools/list HTTP ${listResponse ? listResponse.status : 'unknown'}: ${bodyText || 'empty response'}`);
			}

			const rpc = this._decodeRpcBody(bodyText, listResponse.headers && listResponse.headers.get('content-type'), listRequestId);
			if (!rpc || rpc.error) {
				throw new Error(rpc && rpc.error && rpc.error.message ? rpc.error.message : 'TradingView MCP tools/list RPC error');
			}
			const result = rpc.result;
			if (!result) {
				return [];
			}
			return extractToolNamesFromListResponse(result);
		})();
	}

	_decodeRpcBody(bodyText, contentType = '', expectedId = null) {
		if (!bodyText) {
			return null;
		}

		if (contentType && contentType.includes('application/json')) {
			try {
				return JSON.parse(bodyText);
			} catch {
				return null;
			}
		}

		const dataLines = bodyText
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.startsWith('data:'))
			.map(line => line.substring(5).trim())
			.filter(Boolean);

		if (dataLines.length === 0) {
			return null;
		}

		const parsedPayloads = dataLines
			.map(line => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);

		if (parsedPayloads.length === 0) {
			return null;
		}

		if (expectedId) {
			const matched = parsedPayloads.find(item => String(item.id) === String(expectedId));
			if (matched) {
				return matched;
			}
		}

		return parsedPayloads[0];
	}

	async discover({ force = false } = {}) {
		const cached = this._getCachedDiscovery();
		if (cached && !force) {
			return cached;
		}

		if (this._discoverInFlight) {
			return this._discoverInFlight;
		}

		this._discoverInFlight = (async () => {
			try {
				const names = await this._discoverFromUpstream();
				const sanitized = Array.from(new Set(names.map(sanitizeToolName).filter(Boolean)));
				if (sanitized.length === 0) {
					throw new Error('TradingView MCP tools/list returned an empty tool list');
				}
				this._discoveredNames = sanitized;
				this._discoveredAt = this._now();
				this._discoveredSource = 'tools/list';
				this._discoverLastError = null;
				return {
					names: sanitized.slice(),
					discoveredAt: new Date(this._discoveredAt).toISOString(),
					source: 'tools/list',
				};
			} catch (error) {
				this._discoverLastError = error && error.message ? error.message : 'unknown error';
				const fallbackNames = this._fallbackCatalog.slice();
				this._discoveredNames = fallbackNames;
				this._discoveredAt = this._now();
				this._discoveredSource = 'fallback-static-catalog';
				this._logger?.warn?.(`[McpToolInventory] tools/list discovery failed (${this._discoverLastError}); falling back to static catalog`);
				return {
					names: fallbackNames,
					discoveredAt: new Date(this._discoveredAt).toISOString(),
					source: 'fallback-static-catalog',
				};
			} finally {
				this._discoverInFlight = null;
			}
		})();

		return this._discoverInFlight;
	}

	_buildWiredSnapshot(discoveredNames) {
		const discoveredSet = new Set(discoveredNames);
		const wired = {};
		for (const entry of this._wiredCatalog) {
			if (!discoveredSet.has(entry.name)) {
				continue;
			}
			const telemetry = this._telemetry.get(entry.name) || {
				lastSuccessAt: null,
				lastFailureAt: null,
				lastCategory: null,
			};
			wired[entry.name] = {
				wired: true,
				callers: Array.isArray(entry.callers) ? entry.callers.slice() : [],
				lastSuccessAt: telemetry.lastSuccessAt,
				lastFailureAt: telemetry.lastFailureAt,
				lastCategory: telemetry.lastCategory,
			};
		}
		for (const [toolName, telemetry] of this._telemetry.entries()) {
			if (WIRED_TOOL_NAMES.has(toolName)) {
				continue;
			}
			if (!discoveredSet.has(toolName)) {
				continue;
			}
			wired[toolName] = {
				wired: true,
				callers: [],
				lastSuccessAt: telemetry.lastSuccessAt,
				lastFailureAt: telemetry.lastFailureAt,
				lastCategory: telemetry.lastCategory,
			};
		}
		return wired;
	}

	async snapshot({ discover = true } = {}) {
		let discovery;
		if (discover) {
			discovery = await this.discover();
		} else if (this._discoveredNames && this._discoveredAt) {
			discovery = this._getCachedDiscovery() || {
				names: this._discoveredNames.slice(),
				discoveredAt: new Date(this._discoveredAt).toISOString(),
				source: this._discoveredSource || 'fallback-static-catalog',
			};
		} else {
			discovery = {
				names: this._fallbackCatalog.slice(),
				discoveredAt: new Date(this._now()).toISOString(),
				source: 'fallback-static-catalog',
			};
		}

		const discoveredNames = discovery.names;
		const wired = this._buildWiredSnapshot(discoveredNames);

		for (const discoveredName of discoveredNames) {
			if (wired[discoveredName]) {
				continue;
			}
			wired[discoveredName] = {
				wired: false,
				callers: [],
				lastSuccessAt: null,
				lastFailureAt: null,
				lastCategory: null,
			};
		}

		return {
			discovered: discoveredNames,
			wired,
			discoveredAt: discovery.discoveredAt,
			discoveredSource: discovery.source,
		};
	}

	_resetForTesting() {
		this._discoveredNames = null;
		this._discoveredAt = null;
		this._discoveredSource = null;
		this._discoverInFlight = null;
		this._discoverLastError = null;
		this._telemetry.clear();
		this._initTelemetry();
	}
}

module.exports = {
	McpToolInventory,
	STATIC_FALLBACK_CATALOG,
	WIRED_TOOLS,
	DEFAULT_DISCOVERY_TTL_MS,
	DEFAULT_DISCOVERY_TIMEOUT_MS,
};