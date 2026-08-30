jest.mock('../../src/services/monitoring/SentryService', () => ({
	captureRuntimeError: jest.fn(),
}));

const {
	extractChatId,
	getResolvedAllowedChatIds,
	getStatus,
	isChatAuthorized,
	parseAllowedChatIds,
	registerAuthMiddleware,
	resetSilentDropState,
} = require('../../src/lib/telegramCommandAuth');

function withEnv(overrides, run) {
	const original = process.env;
	process.env = { ...original };
	Object.entries(overrides).forEach(([key, value]) => {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	});
	return Promise.resolve()
		.then(run)
		.finally(() => {
			process.env = original;
		});
}

describe('parseAllowedChatIds', () => {
	it('returns an empty array for missing or empty values', () => {
		expect(parseAllowedChatIds(undefined)).toEqual([]);
		expect(parseAllowedChatIds('')).toEqual([]);
		expect(parseAllowedChatIds('   ')).toEqual([]);
	});

	it('splits, trims, and drops empty entries', () => {
		expect(parseAllowedChatIds('123, 456 , ,789')).toEqual(['123', '456', '789']);
	});
});

describe('getResolvedAllowedChatIds', () => {
	beforeEach(() => {
		resetSilentDropState();
	});

	it('prefers TELEGRAM_ALLOWED_CHAT_IDS when set', async () => {
		await withEnv(
			{
				TELEGRAM_ALLOWED_CHAT_IDS: '111,222',
				TELEGRAM_CHAT_ID: '999',
			},
			() => {
				expect(getResolvedAllowedChatIds()).toEqual(['111', '222']);
			},
		);
	});

	it('falls back to TELEGRAM_CHAT_ID when the explicit list is empty', async () => {
		await withEnv(
			{
				TELEGRAM_ALLOWED_CHAT_IDS: '',
				TELEGRAM_CHAT_ID: '555',
			},
			() => {
				expect(getResolvedAllowedChatIds()).toEqual(['555']);
			},
		);
	});

	it('returns an empty array when no allowlist is configured', async () => {
		await withEnv(
			{
				TELEGRAM_ALLOWED_CHAT_IDS: undefined,
				TELEGRAM_CHAT_ID: undefined,
			},
			() => {
				expect(getResolvedAllowedChatIds()).toEqual([]);
			},
		);
	});
});

describe('isChatAuthorized', () => {
	beforeEach(() => {
		resetSilentDropState();
	});

	it('rejects nullish and unknown chat ids when the allowlist is non-empty', async () => {
		await withEnv({ TELEGRAM_ALLOWED_CHAT_IDS: '100' }, () => {
			expect(isChatAuthorized(null)).toBe(false);
			expect(isChatAuthorized(undefined)).toBe(false);
			expect(isChatAuthorized('999')).toBe(false);
		});
	});

	it('rejects every chat id when no allowlist is configured (fail-closed)', async () => {
		await withEnv(
			{ TELEGRAM_ALLOWED_CHAT_IDS: undefined, TELEGRAM_CHAT_ID: undefined },
			() => {
				expect(isChatAuthorized('100')).toBe(false);
				expect(isChatAuthorized(100)).toBe(false);
			},
		);
	});

	it('matches numeric chat ids after string normalization', async () => {
		await withEnv({ TELEGRAM_ALLOWED_CHAT_IDS: '100,200' }, () => {
			expect(isChatAuthorized(100)).toBe(true);
			expect(isChatAuthorized('200')).toBe(true);
			expect(isChatAuthorized(300)).toBe(false);
		});
	});
});

describe('getStatus', () => {
	beforeEach(() => {
		resetSilentDropState();
	});

	it('reports source, size, and drops when an explicit allowlist is configured', async () => {
		await withEnv(
			{
				TELEGRAM_ALLOWED_CHAT_IDS: '111,222',
				TELEGRAM_CHAT_ID: '999',
			},
			() => {
				const status = getStatus();
				expect(status.enabled).toBe(true);
				expect(status.allowlistSource).toBe('TELEGRAM_ALLOWED_CHAT_IDS');
				expect(status.allowlistSize).toBe(2);
				expect(status.deniedSinceStart).toBe(0);
			},
		);
	});

	it('marks status as not enabled when no allowlist is set', async () => {
		await withEnv(
			{ TELEGRAM_ALLOWED_CHAT_IDS: undefined, TELEGRAM_CHAT_ID: undefined },
			() => {
				const status = getStatus();
				expect(status.enabled).toBe(false);
				expect(status.allowlistSize).toBe(0);
			},
		);
	});
});

describe('extractChatId', () => {
	it('reads from update.message first', () => {
		const context = {
			update: { message: { chat: { id: 11 } } },
		};
		expect(extractChatId(context)).toBe(11);
	});

	it('falls back to edited_message, channel_post, and edited_channel_post', () => {
		expect(extractChatId({ update: { edited_message: { chat: { id: 22 } } } })).toBe(22);
		expect(extractChatId({ update: { channel_post: { chat: { id: 33 } } } })).toBe(33);
		expect(extractChatId({ update: { edited_channel_post: { chat: { id: 44 } } } })).toBe(44);
	});

	it('returns undefined when no chat id is present', () => {
		expect(extractChatId({ update: {} })).toBeUndefined();
		expect(extractChatId({ message: {} })).toBeUndefined();
		expect(extractChatId({})).toBeUndefined();
	});
});

describe('registerAuthMiddleware', () => {
	beforeEach(() => {
		resetSilentDropState();
	});

	function buildBotStub() {
		const handlers = [];
		return {
			handlers,
			use: jest.fn((middleware) => {
				handlers.push(middleware);
			}),
		};
	}

	it('does nothing when bot is missing or lacks `use`', () => {
		expect(() => registerAuthMiddleware(undefined)).not.toThrow();
		expect(() => registerAuthMiddleware({})).not.toThrow();
	});

	it('registers two middlewares that gate by allowlist and forward authorized updates', async () => {
		await withEnv({ TELEGRAM_ALLOWED_CHAT_IDS: '777' }, async () => {
			const bot = buildBotStub();
			registerAuthMiddleware(bot);

			expect(bot.use).toHaveBeenCalledTimes(2);
			expect(bot.handlers).toHaveLength(2);

			const allowedContext = {
				update: { message: { chat: { id: 777 } } },
			};
			const next = jest.fn().mockResolvedValue('ok');
			await expect(bot.handlers[0](allowedContext, next)).resolves.toBe('ok');
			expect(next).toHaveBeenCalledTimes(1);

			const deniedContext = {
				update: { message: { chat: { id: 123 } } },
			};
			const deniedNext = jest.fn();
			await expect(bot.handlers[0](deniedContext, deniedNext)).resolves.toBeUndefined();
			expect(deniedNext).not.toHaveBeenCalled();
		});
	});

	it('logs denied senders once per cooldown window and tracks unique senders', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		await withEnv({ TELEGRAM_ALLOWED_CHAT_IDS: '777' }, async () => {
			const bot = buildBotStub();
			registerAuthMiddleware(bot);
			const [, withLogging] = bot.handlers;

			const deniedContext = {
				update: { message: { chat: { id: 'denier' } } },
			};
			await bot.handlers[0](deniedContext, jest.fn());
			await bot.handlers[0](deniedContext, jest.fn());

			expect(warn).toHaveBeenCalledTimes(1);
			expect(getStatus().deniedSinceStart).toBe(1);

			// Errors thrown inside next are captured by the logging wrapper.
			const error = new Error('boom');
			const throwingNext = jest.fn().mockRejectedValue(error);
			await expect(withLogging(deniedContext, throwingNext)).rejects.toBe(error);

			const sentry = require('../../src/services/monitoring/SentryService');
			expect(sentry.captureRuntimeError).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: 'telegram',
					feature: 'telegram-command-auth',
				}),
			);
		});
		warn.mockRestore();
	});
});
