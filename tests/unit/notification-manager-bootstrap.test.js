/* global jest, describe, it, expect, beforeEach, afterEach */

const bootstrapModule = require('../../src/services/notification/NotificationManagerBootstrap');

function makeChannel(name) {
	return {
		name,
		validate: jest.fn().mockResolvedValue({ valid: true, message: `${name}-ok` }),
		isEnabled: jest.fn(() => true),
		send: jest.fn().mockResolvedValue({ success: true, channel: name }),
		getEnabledChannels: jest.fn(() => [name]),
	};
}

describe('NotificationManagerBootstrap', () => {
	beforeEach(() => {
		bootstrapModule.resetForTesting();
	});

	afterEach(() => {
		bootstrapModule.resetForTesting();
		jest.restoreAllMocks();
		jest.resetModules();
	});

	it('exposes initialize/getOrInitialize/getInitialized/getBootstrapStatus', () => {
		expect(typeof bootstrapModule.initialize).toBe('function');
		expect(typeof bootstrapModule.getOrInitialize).toBe('function');
		expect(typeof bootstrapModule.getInitialized).toBe('function');
		expect(typeof bootstrapModule.getBootstrapStatus).toBe('function');
		expect(typeof bootstrapModule.resetForTesting).toBe('function');
	});

	it('initializes the manager exactly once and caches the result', async () => {
		const telegram = makeChannel('telegram');
		const whatsapp = makeChannel('whatsapp');
		const discord = makeChannel('discord');

		jest.doMock('../../src/services/notification/TelegramService', () => jest.fn(() => telegram));
		jest.doMock('../../src/services/notification/WhatsAppService', () => jest.fn(() => whatsapp));
		jest.doMock('../../src/services/notification/DiscordService', () => jest.fn(() => discord));
		jest.doMock('../../src/services/notification/NotificationManager', () => jest.fn().mockImplementation(() => ({
			validateAll: jest.fn().mockResolvedValue(undefined),
			getEnabledChannels: () => ['telegram'],
		})));

		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		const first = await fresh.initialize({ stub: 'bot' });
		const third = await fresh.initialize({ stub: 'bot-different' });

		expect(first).toBe(third);
		expect(fresh.getInitialized()).toBe(first);
	});

	it('shares the in-flight Promise across concurrent getOrInitialize callers', async () => {
		const telegram = makeChannel('telegram');
		const whatsapp = makeChannel('whatsapp');
		const discord = makeChannel('discord');

		let resolveValidate;
		const slowManager = {
			validateAll: jest.fn().mockImplementation(() => new Promise((resolve) => {
				resolveValidate = resolve;
			})),
			getEnabledChannels: () => ['telegram'],
		};

		jest.doMock('../../src/services/notification/TelegramService', () => jest.fn(() => telegram));
		jest.doMock('../../src/services/notification/WhatsAppService', () => jest.fn(() => whatsapp));
		jest.doMock('../../src/services/notification/DiscordService', () => jest.fn(() => discord));
		jest.doMock('../../src/services/notification/NotificationManager', () => jest.fn().mockImplementation(() => slowManager));

		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		const first = fresh.getOrInitialize({});
		const second = fresh.getOrInitialize({});
		const third = fresh.initialize({});

		resolveValidate();
		const [a, b, c] = await Promise.all([first, second, third]);

		expect(a).toBe(b);
		expect(b).toBe(c);
		expect(slowManager.validateAll).toHaveBeenCalledTimes(1);
	});

	it('returns the cached manager from getOrInitialize without re-initializing', async () => {
		const telegram = makeChannel('telegram');
		const whatsapp = makeChannel('whatsapp');
		const discord = makeChannel('discord');
		const mockCtor = jest.fn().mockImplementation(() => ({
			validateAll: jest.fn().mockResolvedValue(undefined),
			getEnabledChannels: () => ['telegram'],
		}));

		jest.doMock('../../src/services/notification/TelegramService', () => jest.fn(() => telegram));
		jest.doMock('../../src/services/notification/WhatsAppService', () => jest.fn(() => whatsapp));
		jest.doMock('../../src/services/notification/DiscordService', () => jest.fn(() => discord));
		jest.doMock('../../src/services/notification/NotificationManager', () => mockCtor);

		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		const initial = await fresh.initialize({});
		const reused = await fresh.getOrInitialize({});

		expect(reused).toBe(initial);
		expect(mockCtor).toHaveBeenCalledTimes(1);
	});

	it('getInitialized returns null until initialize completes', () => {
		expect(bootstrapModule.getInitialized()).toBeNull();
	});

	it('records bootstrap status metadata', async () => {
		const telegram = makeChannel('telegram');
		const whatsapp = makeChannel('whatsapp');
		const discord = makeChannel('discord');

		jest.doMock('../../src/services/notification/TelegramService', () => jest.fn(() => telegram));
		jest.doMock('../../src/services/notification/WhatsAppService', () => jest.fn(() => whatsapp));
		jest.doMock('../../src/services/notification/DiscordService', () => jest.fn(() => discord));
		jest.doMock('../../src/services/notification/NotificationManager', () => jest.fn().mockImplementation(() => ({
			validateAll: jest.fn().mockResolvedValue(undefined),
			getEnabledChannels: () => ['telegram', 'whatsapp'],
		})));

		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		await fresh.initialize({});
		const status = fresh.getBootstrapStatus();

		expect(status.initialized).toBe(true);
		expect(status.lastInitSucceeded).toBe(true);
		expect(status.lastInitStartedAt).toBeGreaterThan(0);
		expect(status.lastInitFinishedAt).toBeGreaterThanOrEqual(status.lastInitStartedAt);
		expect(status.enabledChannels).toEqual(['telegram', 'whatsapp']);
	});

	it('resolves a getOrInitialize call to null when bot is unavailable', async () => {
		const telegram = makeChannel('telegram');
		const whatsapp = makeChannel('whatsapp');
		const discord = makeChannel('discord');

		jest.doMock('../../src/services/notification/TelegramService', () => jest.fn(() => {
			throw new Error('no bot available');
		}));
		jest.doMock('../../src/services/notification/WhatsAppService', () => jest.fn(() => whatsapp));
		jest.doMock('../../src/services/notification/DiscordService', () => jest.fn(() => discord));
		jest.doMock('../../src/services/notification/NotificationManager', () => jest.fn());

		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		const result = await fresh.getOrInitialize(null);

		expect(result).toBeNull();
		expect(fresh.getInitialized()).toBeNull();
	});

	it('rejects getOrInitialize cleanly when bot getter throws', async () => {
		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		const result = await fresh.getOrInitialize(() => {
			throw new Error('bot getter exploded');
		});

		expect(result).toBeNull();
	});

	it('resetForTesting clears cached manager and in-flight Promise', async () => {
		const telegram = makeChannel('telegram');
		const whatsapp = makeChannel('whatsapp');
		const discord = makeChannel('discord');

		jest.doMock('../../src/services/notification/TelegramService', () => jest.fn(() => telegram));
		jest.doMock('../../src/services/notification/WhatsAppService', () => jest.fn(() => whatsapp));
		jest.doMock('../../src/services/notification/DiscordService', () => jest.fn(() => discord));
		jest.doMock('../../src/services/notification/NotificationManager', () => jest.fn().mockImplementation(() => ({
			validateAll: jest.fn().mockResolvedValue(undefined),
			getEnabledChannels: () => ['telegram'],
		})));

		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		await fresh.initialize({});
		expect(fresh.getInitialized()).not.toBeNull();

		fresh.resetForTesting();
		expect(fresh.getInitialized()).toBeNull();
	});
});