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
		jest.dontMock('../../src/services/notification/TelegramService');
		jest.dontMock('../../src/services/notification/WhatsAppService');
		jest.dontMock('../../src/services/notification/DiscordService');
		jest.dontMock('../../src/services/notification/NotificationManager');
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

	it('getInitialized returns null before initialization starts', () => {
		expect(bootstrapModule.getInitialized()).toBeNull();
	});

	it('publishes the manager while channel validation is still pending', async () => {
		const telegram = makeChannel('telegram');
		const whatsapp = makeChannel('whatsapp');
		const discord = makeChannel('discord');
		let resolveValidation;
		const manager = {
			validateAll: jest.fn(() => new Promise((resolve) => {
				resolveValidation = resolve;
			})),
			getEnabledChannels: () => ['telegram'],
		};

		jest.doMock('../../src/services/notification/TelegramService', () => jest.fn(() => telegram));
		jest.doMock('../../src/services/notification/WhatsAppService', () => jest.fn(() => whatsapp));
		jest.doMock('../../src/services/notification/DiscordService', () => jest.fn(() => discord));
		jest.doMock('../../src/services/notification/NotificationManager', () => jest.fn(() => manager));

		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		const initialization = fresh.initialize({ id: 'startup-bot' });
		const managerDuringValidation = fresh.getInitialized();
		const statusDuringValidation = fresh.getBootstrapStatus();
		resolveValidation();
		await initialization;

		expect(managerDuringValidation).toBe(manager);
		expect(statusDuringValidation.initialized).toBe(false);
		expect(statusDuringValidation.enabledChannels).toEqual([]);
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

	it('rejects initialization when a notification service cannot be constructed', async () => {
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

		await expect(fresh.getOrInitialize(null)).rejects.toThrow('no bot available');

		expect(fresh.getInitialized()).toBeNull();
		expect(fresh.getBootstrapStatus().lastInitSucceeded).toBe(false);
	});

	it('clears a manager after validation rejects so a later initialization can retry', async () => {
		const telegram = makeChannel('telegram');
		const whatsapp = makeChannel('whatsapp');
		const discord = makeChannel('discord');
		const failedManager = {
			validateAll: jest.fn().mockRejectedValue(new Error('validation failed')),
			getEnabledChannels: () => ['telegram'],
		};
		const retryManager = {
			validateAll: jest.fn().mockResolvedValue(undefined),
			getEnabledChannels: () => ['telegram'],
		};
		const managerCtor = jest.fn()
			.mockImplementationOnce(() => failedManager)
			.mockImplementationOnce(() => retryManager);

		jest.doMock('../../src/services/notification/TelegramService', () => jest.fn(() => telegram));
		jest.doMock('../../src/services/notification/WhatsAppService', () => jest.fn(() => whatsapp));
		jest.doMock('../../src/services/notification/DiscordService', () => jest.fn(() => discord));
		jest.doMock('../../src/services/notification/NotificationManager', () => managerCtor);

		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		const failedInitialization = fresh.initialize({ id: 'failed-bot' });
		await expect(failedInitialization).rejects.toThrow('validation failed');
		expect(fresh.getInitialized()).toBeNull();

		const retried = await fresh.getOrInitialize({ id: 'retry-bot' });
		expect(retried).toBe(retryManager);
		expect(managerCtor).toHaveBeenCalledTimes(2);
	});

	it('rejects a throwing bot getter without poisoning the singleton', async () => {
		const telegram = makeChannel('telegram');
		const whatsapp = makeChannel('whatsapp');
		const discord = makeChannel('discord');
		const managerCtor = jest.fn().mockImplementation(() => ({
			validateAll: jest.fn().mockResolvedValue(undefined),
			getEnabledChannels: () => ['telegram'],
		}));

		jest.doMock('../../src/services/notification/TelegramService', () => jest.fn(() => telegram));
		jest.doMock('../../src/services/notification/WhatsAppService', () => jest.fn(() => whatsapp));
		jest.doMock('../../src/services/notification/DiscordService', () => jest.fn(() => discord));
		jest.doMock('../../src/services/notification/NotificationManager', () => managerCtor);
		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		await expect(fresh.getOrInitialize(() => {
			throw new Error('bot getter exploded');
		})).rejects.toThrow('bot getter exploded');

		expect(managerCtor).not.toHaveBeenCalled();
		expect(fresh.getInitialized()).toBeNull();
		const initialized = await fresh.getOrInitialize({ id: 'valid-bot' });
		expect(initialized).not.toBeNull();
		expect(managerCtor).toHaveBeenCalledTimes(1);
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

	it('does not let a pre-reset initialization overwrite or clear a newer initialization', async () => {
		const telegram = makeChannel('telegram');
		const whatsapp = makeChannel('whatsapp');
		const discord = makeChannel('discord');
		const deferred = () => {
			let resolve;
			const promise = new Promise((done) => {
				resolve = done;
			});
			return { promise, resolve };
		};
		const oldValidation = deferred();
		const newValidation = deferred();
		const oldManager = {
			validateAll: jest.fn(() => oldValidation.promise),
			getEnabledChannels: () => ['old'],
		};
		const newManager = {
			validateAll: jest.fn(() => newValidation.promise),
			getEnabledChannels: () => ['new'],
		};
		const managerCtor = jest.fn()
			.mockImplementationOnce(() => oldManager)
			.mockImplementationOnce(() => newManager);

		jest.doMock('../../src/services/notification/TelegramService', () => jest.fn(() => telegram));
		jest.doMock('../../src/services/notification/WhatsAppService', () => jest.fn(() => whatsapp));
		jest.doMock('../../src/services/notification/DiscordService', () => jest.fn(() => discord));
		jest.doMock('../../src/services/notification/NotificationManager', () => managerCtor);

		jest.resetModules();
		const fresh = require('../../src/services/notification/NotificationManagerBootstrap');

		const oldInitialization = fresh.getOrInitialize({ id: 'old' });
		fresh.resetForTesting();
		const newInitialization = fresh.getOrInitialize({ id: 'new' });

		oldValidation.resolve();
		await oldInitialization;

		expect(fresh.getInitialized()).toBe(newManager);
		const joinedNewInitialization = fresh.getOrInitialize({ id: 'third' });
		expect(joinedNewInitialization).toBe(newInitialization);
		expect(managerCtor).toHaveBeenCalledTimes(2);

		newValidation.resolve();
		await newInitialization;
		expect(fresh.getInitialized()).toBe(newManager);
	});
});
