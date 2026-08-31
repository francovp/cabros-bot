const {
	isDeepRequested,
	computeDeepHealth,
	getChannelReadinessSnapshot,
} = require('../../src/controllers/healthcheck');

describe('healthcheck helpers', () => {
	describe('isDeepRequested', () => {
		it('returns true for ?deep=true', () => {
			expect(isDeepRequested({ query: { deep: 'true' } })).toBe(true);
		});

		it('returns true for ?deep=TRUE (case insensitive)', () => {
			expect(isDeepRequested({ query: { deep: 'TRUE' } })).toBe(true);
		});

		it('returns false when query param is missing', () => {
			expect(isDeepRequested({ query: {} })).toBe(false);
		});

		it('returns false when query param is "false"', () => {
			expect(isDeepRequested({ query: { deep: 'false' } })).toBe(false);
		});

		it('returns false when req is undefined', () => {
			expect(isDeepRequested(undefined)).toBe(false);
		});
	});

	describe('computeDeepHealth', () => {
		it('reports healthy when no channels are enabled', () => {
			expect(computeDeepHealth({
				telegram: { enabled: false, ready: false, status: 'disabled' },
				whatsapp: { enabled: false, ready: false, status: 'disabled' },
				discord: { enabled: false, ready: false, status: 'disabled' },
			}).healthy).toBe(true);
		});

		it('reports healthy when all enabled channels are ready', () => {
			expect(computeDeepHealth({
				telegram: { enabled: true, ready: true, status: 'ready' },
				whatsapp: { enabled: true, ready: true, status: 'ready' },
				discord: { enabled: false, ready: false, status: 'disabled' },
			}).healthy).toBe(true);
		});

		it('reports degraded when one enabled channel is not ready', () => {
			const result = computeDeepHealth({
				telegram: { enabled: true, ready: true, status: 'ready' },
				whatsapp: { enabled: true, ready: false, status: 'error' },
				discord: { enabled: false, ready: false, status: 'disabled' },
			});
			expect(result.healthy).toBe(false);
			expect(result.degradedChannels).toEqual(['whatsapp']);
		});

		it('reports degraded when an enabled channel has status="misconfigured"', () => {
			const result = computeDeepHealth({
				telegram: { enabled: true, ready: false, status: 'misconfigured' },
				whatsapp: { enabled: false, ready: false, status: 'disabled' },
				discord: { enabled: false, ready: false, status: 'disabled' },
			});
			expect(result.healthy).toBe(false);
			expect(result.degradedChannels).toEqual(['telegram']);
		});
	});

	describe('getChannelReadinessSnapshot', () => {
		it('falls back to {enabled:false, ready:false, status:"unknown"} when dependency is missing', () => {
			jest.isolateModules(() => {
				const statusMod = require('../../src/controllers/status');
				const healthMod = require('../../src/controllers/healthcheck');
				const original = statusMod.getStatus;
				statusMod.getStatus = () => ({ dependencies: {} });
				try {
					const snap = healthMod.getChannelReadinessSnapshot();
					expect(snap.telegram.enabled).toBe(false);
					expect(snap.telegram.status).toBe('unknown');
				} finally {
					statusMod.getStatus = original;
				}
			});
		});

		it('returns safe defaults when statusController.getStatus throws', () => {
			jest.isolateModules(() => {
				const statusMod = require('../../src/controllers/status');
				const healthMod = require('../../src/controllers/healthcheck');
				const original = statusMod.getStatus;
				statusMod.getStatus = () => {
					throw new Error('boom');
				};
				try {
					const snap = healthMod.getChannelReadinessSnapshot();
					expect(snap.telegram.enabled).toBe(false);
					expect(snap.telegram.ready).toBe(false);
					expect(snap.telegram.status).toBe('unknown');
				} finally {
					statusMod.getStatus = original;
				}
			});
		});
	});
});