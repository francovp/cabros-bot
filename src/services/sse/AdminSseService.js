'use strict';

const { v4: uuidv4 } = require('uuid');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_MAX_CLIENT_CONNECTIONS = 5;
const DEFAULT_MAX_TOTAL_CONNECTIONS = 100;
const RETRY_INTERVAL_MS = 5000;

class AdminSseService {
	constructor(options = {}) {
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? null;
		this.maxClientConnections = options.maxClientConnections ?? null;
		this.maxTotalConnections = options.maxTotalConnections ?? null;
		this.logger = options.logger || console;

		this.clients = new Map();
		this.clientKeyCounts = new Map();
		this.heartbeatTimer = null;
	}

	isEnabled() {
		if (process.env.ENABLE_ADMIN_SSE !== undefined) {
			return process.env.ENABLE_ADMIN_SSE === 'true' || process.env.ENABLE_ADMIN_SSE === true;
		}
		return true;
	}

	getEffectiveHeartbeatIntervalMs() {
		if (Number.isSafeInteger(this.heartbeatIntervalMs) && this.heartbeatIntervalMs >= 1000) {
			return this.heartbeatIntervalMs;
		}
		const remote = getRuntimeConfig?.()?.ADMIN_SSE_HEARTBEAT_MS;
		if (Number.isSafeInteger(remote) && remote >= 1000) {
			return remote;
		}
		const env = Number(process.env.ADMIN_SSE_HEARTBEAT_MS);
		if (Number.isSafeInteger(env) && env >= 1000) {
			return env;
		}
		return DEFAULT_HEARTBEAT_MS;
	}

	getEffectiveMaxClientConnections() {
		if (Number.isSafeInteger(this.maxClientConnections) && this.maxClientConnections >= 1) {
			return this.maxClientConnections;
		}
		const remote = getRuntimeConfig?.()?.ADMIN_SSE_MAX_CLIENT_CONNECTIONS;
		if (Number.isSafeInteger(remote) && remote >= 1) {
			return remote;
		}
		const env = Number(process.env.ADMIN_SSE_MAX_CLIENT_CONNECTIONS);
		if (Number.isSafeInteger(env) && env >= 1) {
			return env;
		}
		return DEFAULT_MAX_CLIENT_CONNECTIONS;
	}

	getEffectiveMaxTotalConnections() {
		if (Number.isSafeInteger(this.maxTotalConnections) && this.maxTotalConnections >= 1) {
			return this.maxTotalConnections;
		}
		const remote = getRuntimeConfig?.()?.ADMIN_SSE_MAX_TOTAL_CONNECTIONS;
		if (Number.isSafeInteger(remote) && remote >= 1) {
			return remote;
		}
		const env = Number(process.env.ADMIN_SSE_MAX_TOTAL_CONNECTIONS);
		if (Number.isSafeInteger(env) && env >= 1) {
			return env;
		}
		return DEFAULT_MAX_TOTAL_CONNECTIONS;
	}

	getClientCount() {
		return this.clients.size;
	}

	getClientCountForKey(clientKey) {
		const clientIds = this.clientKeyCounts.get(clientKey);
		return clientIds ? clientIds.size : 0;
	}

	addClient(req, res, clientKey = 'anonymous') {
		if (!this.isEnabled()) {
			return {
				ok: false,
				status: 403,
				code: 'FEATURE_DISABLED',
				message: 'Admin SSE stream is disabled.',
			};
		}

		const maxTotal = this.getEffectiveMaxTotalConnections();
		if (this.clients.size >= maxTotal) {
			this.logger.warn?.('[AdminSseService] Global connection capacity exceeded', {
				current: this.clients.size,
				limit: maxTotal,
			});
			if (typeof res.status === 'function' && typeof res.json === 'function' && !res.writableEnded) {
				res.setHeader?.('Retry-After', '30');
				res.status(503).json({
					error: 'Too many active SSE connections',
					code: 'SSE_CONNECTION_LIMIT_EXCEEDED',
				});
			}
			return {
				ok: false,
				status: 503,
				code: 'SSE_CONNECTION_LIMIT_EXCEEDED',
				message: 'Server has reached maximum SSE connection capacity. Please retry shortly.',
			};
		}

		const maxClient = this.getEffectiveMaxClientConnections();
		let clientIds = this.clientKeyCounts.get(clientKey);
		if (!clientIds) {
			clientIds = new Set();
			this.clientKeyCounts.set(clientKey, clientIds);
		}

		// Multi-connection support: if client reached max connections, evict the oldest connection gracefully
		if (clientIds.size >= maxClient) {
			const oldestClientId = clientIds.values().next().value;
			if (oldestClientId) {
				const oldestClient = this.clients.get(oldestClientId);
				if (oldestClient) {
					try {
						oldestClient.res.write(':closing superseded by new connection\n\n');
						oldestClient.res.end();
					} catch (_) {
						// Fail-safe cleanup
					}
					this.removeClient(oldestClientId);
				}
			}
		}

		const clientId = uuidv4();
		const client = {
			id: clientId,
			clientKey,
			req,
			res,
			connectedAt: new Date().toISOString(),
		};

		// Set standard SSE response headers
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no',
		});

		// Flush headers if method is available
		if (typeof res.flushHeaders === 'function') {
			res.flushHeaders();
		}

		// Initial greeting and retry interval
		res.write(`retry: ${RETRY_INTERVAL_MS}\n\n`);
		res.write(':connected\n\n');
		res.write(`event: connected\ndata: ${JSON.stringify({
			clientId,
			timestamp: client.connectedAt,
			activeConnections: this.clients.size + 1,
		})}\n\n`);

		this.clients.set(clientId, client);
		clientIds.add(clientId);

		// Handle disconnect cleanup
		const cleanup = () => this.removeClient(clientId);
		req.once('close', cleanup);
		req.once('error', cleanup);
		res.once('close', cleanup);
		res.once('error', cleanup);

		this._ensureHeartbeatTimer();

		return {
			ok: true,
			clientId,
		};
	}

	removeClient(clientId) {
		const client = this.clients.get(clientId);
		if (!client) return;

		this.clients.delete(clientId);
		const clientIds = this.clientKeyCounts.get(client.clientKey);
		if (clientIds) {
			clientIds.delete(clientId);
			if (clientIds.size === 0) {
				this.clientKeyCounts.delete(client.clientKey);
			}
		}

		try {
			if (!client.res.writableEnded) {
				client.res.end();
			}
		} catch (_) {
			// Fail-safe
		}

		if (this.clients.size === 0) {
			this._stopHeartbeatTimer();
		}
	}

	broadcast(eventType, data) {
		if (this.clients.size === 0) return;

		let formattedData;
		try {
			formattedData = typeof data === 'string' ? data : JSON.stringify(data);
		} catch (error) {
			this.logger.warn?.('[AdminSseService] Failed to serialize broadcast payload:', error.message);
			return;
		}

		const message = `event: ${eventType}\ndata: ${formattedData}\n\n`;

		for (const [clientId, client] of this.clients.entries()) {
			if (client.res.destroyed || client.res.writableEnded) {
				this.removeClient(clientId);
				continue;
			}
			try {
				client.res.write(message);
			} catch (error) {
				this.removeClient(clientId);
			}
		}
	}

	sendHeartbeat() {
		if (this.clients.size === 0) return;

		const message = ':keepalive\n\n';
		for (const [clientId, client] of this.clients.entries()) {
			if (client.res.destroyed || client.res.writableEnded) {
				this.removeClient(clientId);
				continue;
			}
			try {
				client.res.write(message);
			} catch (error) {
				this.removeClient(clientId);
			}
		}
	}

	_ensureHeartbeatTimer() {
		if (this.heartbeatTimer) return;
		const interval = this.getEffectiveHeartbeatIntervalMs();
		this.heartbeatTimer = setInterval(() => {
			this.sendHeartbeat();
		}, interval);
		if (typeof this.heartbeatTimer.unref === 'function') {
			this.heartbeatTimer.unref();
		}
	}

	_stopHeartbeatTimer() {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	closeAll() {
		this._stopHeartbeatTimer();
		for (const [clientId, client] of this.clients.entries()) {
			try {
				client.res.write(':closing server shutdown\n\n');
				client.res.end();
			} catch (_) {
				// Fail-safe
			}
		}
		this.clients.clear();
		this.clientKeyCounts.clear();
	}
}

const adminSseService = new AdminSseService();

module.exports = {
	AdminSseService,
	adminSseService,
};
