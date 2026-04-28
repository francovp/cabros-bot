/**
 * Unit tests for SentryService
 * Feature: 005-sentry-runtime-errors
 *
 * Tests cover:
 * - T010: ErrorEvent building with correct channel, type, environment, and contexts
 * - T018: captureEvent never throws (returns captured=false with skippedReason)
 * - T023: MonitoringConfiguration resolution for various env combinations
 */

const Sentry = require('@sentry/node');
const { SentryService, FEATURE_NAMES } = require('../../src/services/monitoring/SentryService');

describe('SentryService', () => {
	let service;
	const originalEnv = process.env;

	beforeEach(() => {
		// Create fresh instance for each test
		service = new SentryService();
		// Reset env vars
		process.env = { ...originalEnv };
		// Clear all mocks
		jest.clearAllMocks();
	});

	afterEach(() => {
		process.env = originalEnv;
		service._reset();
	});

	describe('Configuration Resolution (T023)', () => {
		describe('environment derivation', () => {
			it('should use SENTRY_ENVIRONMENT when set', () => {
				process.env.SENTRY_ENVIRONMENT = 'custom-env';
				process.env.NODE_ENV = 'production';
				process.env.RENDER = 'true';

				const env = service._deriveEnvironment();
				expect(env).toBe('custom-env');
			});

			it('should return preview when RENDER=true and IS_PULL_REQUEST=true', () => {
				process.env.RENDER = 'true';
				process.env.IS_PULL_REQUEST = 'true';
				delete process.env.SENTRY_ENVIRONMENT;

				const env = service._deriveEnvironment();
				expect(env).toBe('preview');
			});

			it('should return production when NODE_ENV=production', () => {
				process.env.NODE_ENV = 'production';
				delete process.env.SENTRY_ENVIRONMENT;
				delete process.env.RENDER;

				const env = service._deriveEnvironment();
				expect(env).toBe('production');
			});

			it('should return production when RENDER=true (without PR)', () => {
				process.env.RENDER = 'true';
				process.env.IS_PULL_REQUEST = 'false';
				delete process.env.SENTRY_ENVIRONMENT;
				process.env.NODE_ENV = 'development';

				const env = service._deriveEnvironment();
				expect(env).toBe('production');
			});

			it('should return development when no production indicators', () => {
				delete process.env.SENTRY_ENVIRONMENT;
				delete process.env.RENDER;
				process.env.NODE_ENV = 'development';

				const env = service._deriveEnvironment();
				expect(env).toBe('development');
			});
		});

		describe('release derivation', () => {
			it('should use SENTRY_RELEASE when set', () => {
				process.env.SENTRY_RELEASE = 'v1.2.3';
				process.env.RENDER_GIT_COMMIT = 'abc123def';

				const release = service._deriveRelease();
				expect(release).toBe('v1.2.3');
			});

			it('should derive from RENDER_GIT_COMMIT when available', () => {
				delete process.env.SENTRY_RELEASE;
				process.env.RENDER_GIT_COMMIT = 'abc123defghijk';
				process.env.RENDER_GIT_REPO_SLUG = 'myorg/myrepo';

				const release = service._deriveRelease();
				expect(release).toBe('myorg/myrepo@abc123d');
			});

			it('should use default repo slug when RENDER_GIT_REPO_SLUG not set', () => {
				delete process.env.SENTRY_RELEASE;
				process.env.RENDER_GIT_COMMIT = 'abc123defghijk';
				delete process.env.RENDER_GIT_REPO_SLUG;

				const release = service._deriveRelease();
				expect(release).toBe('cabros-bot@abc123d');
			});

			it('should return undefined when no release info available', () => {
				delete process.env.SENTRY_RELEASE;
				delete process.env.RENDER_GIT_COMMIT;

				const release = service._deriveRelease();
				expect(release).toBeUndefined();
			});
		});

		describe('enabled flag', () => {
			it('should be enabled when ENABLE_SENTRY=true and DSN set', () => {
				process.env.ENABLE_SENTRY = 'true';
				process.env.SENTRY_DSN = 'https://key@sentry.io/123';

				const config = service._buildConfiguration();
				expect(config.enabled).toBe(true);
			});

			it('should be disabled when ENABLE_SENTRY is not true', () => {
				process.env.ENABLE_SENTRY = 'false';
				process.env.SENTRY_DSN = 'https://key@sentry.io/123';

				const config = service._buildConfiguration();
				expect(config.enabled).toBe(false);
			});

			it('should be disabled when SENTRY_DSN is missing', () => {
				process.env.ENABLE_SENTRY = 'true';
				delete process.env.SENTRY_DSN;

				const config = service._buildConfiguration();
				expect(config.enabled).toBe(false);
			});

			it('should be disabled when SENTRY_DSN is empty', () => {
				process.env.ENABLE_SENTRY = 'true';
				process.env.SENTRY_DSN = '';

				const config = service._buildConfiguration();
				expect(config.enabled).toBe(false);
			});
		});

		describe('sendAlertContent', () => {
			it('should default to true', () => {
				delete process.env.SENTRY_SEND_ALERT_CONTENT;

				const config = service._buildConfiguration();
				expect(config.sendAlertContent).toBe(true);
			});

			it('should be false when SENTRY_SEND_ALERT_CONTENT=false', () => {
				process.env.SENTRY_SEND_ALERT_CONTENT = 'false';

				const config = service._buildConfiguration();
				expect(config.sendAlertContent).toBe(false);
			});

			it('should be true for any value other than false', () => {
				process.env.SENTRY_SEND_ALERT_CONTENT = 'true';

				const config = service._buildConfiguration();
				expect(config.sendAlertContent).toBe(true);
			});
		});

		describe('sampleRateErrors', () => {
			it('should default to 1.0', () => {
				delete process.env.SENTRY_SAMPLE_RATE_ERRORS;

				const config = service._buildConfiguration();
				expect(config.sampleRateErrors).toBe(1.0);
			});

			it('should parse float from env', () => {
				process.env.SENTRY_SAMPLE_RATE_ERRORS = '0.5';

				const config = service._buildConfiguration();
				expect(config.sampleRateErrors).toBe(0.5);
			});
		});
	});

	describe('init()', () => {
		it('should initialize Sentry when enabled', () => {
			process.env.ENABLE_SENTRY = 'true';
			process.env.SENTRY_DSN = 'https://key@sentry.io/123';

			service.init();

			expect(Sentry.init).toHaveBeenCalledTimes(1);
			expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({
				dsn: 'https://key@sentry.io/123',
				tracesSampleRate: 0,
			}));
			expect(service.isEnabled()).toBe(true);
			expect(service.getState().configured).toBe(true);
		});

		it('should not initialize Sentry when disabled', () => {
			process.env.ENABLE_SENTRY = 'false';
			process.env.SENTRY_DSN = 'https://key@sentry.io/123';

			service.init();

			expect(Sentry.init).not.toHaveBeenCalled();
			expect(service.isEnabled()).toBe(false);
			expect(service.getState().lastInitError).toBe('ENABLE_SENTRY is not true');
		});

		it('should not initialize Sentry when DSN missing', () => {
			process.env.ENABLE_SENTRY = 'true';
			delete process.env.SENTRY_DSN;

			service.init();

			expect(Sentry.init).not.toHaveBeenCalled();
			expect(service.isEnabled()).toBe(false);
			expect(service.getState().lastInitError).toBe('SENTRY_DSN not configured');
		});
	});

	describe('captureEvent() (T018)', () => {
		it('should return captured=false when monitoring disabled', () => {
			process.env.ENABLE_SENTRY = 'false';
			service.init();

			const result = service.captureEvent({
				event: {
					type: 'runtime_error',
					channel: 'http-alert',
					message: 'Test error',
					environment: 'development',
					isProcessLevel: false,
					timestamp: Date.now(),
				},
			});

			expect(result.captured).toBe(false);
			expect(result.skippedReason).toBeDefined();
			expect(Sentry.captureException).not.toHaveBeenCalled();
		});

		it('should capture event when enabled', () => {
			process.env.ENABLE_SENTRY = 'true';
			process.env.SENTRY_DSN = 'https://key@sentry.io/123';
			service.init();

			const result = service.captureEvent({
				event: {
					type: 'runtime_error',
					channel: 'http-alert',
					message: 'Test error',
					environment: 'development',
					isProcessLevel: false,
					timestamp: Date.now(),
				},
			});

			expect(result.captured).toBe(true);
			expect(result.eventId).toBe('mock-event-id');
			expect(Sentry.captureException).toHaveBeenCalledTimes(1);
		});

		it('should never throw even if Sentry fails', () => {
			process.env.ENABLE_SENTRY = 'true';
			process.env.SENTRY_DSN = 'https://key@sentry.io/123';
			service.init();

			// Make Sentry.captureException throw
			Sentry.captureException.mockImplementationOnce(() => {
				throw new Error('Sentry SDK error');
			});

			// Should not throw
			const result = service.captureEvent({
				event: {
					type: 'runtime_error',
					channel: 'http-alert',
					message: 'Test error',
					environment: 'development',
					isProcessLevel: false,
					timestamp: Date.now(),
				},
			});

			expect(result.captured).toBe(false);
			expect(result.skippedReason).toContain('Capture error');
		});
	});

	describe('ErrorEvent Building (T010)', () => {
		beforeEach(() => {
			process.env.ENABLE_SENTRY = 'true';
			process.env.SENTRY_DSN = 'https://key@sentry.io/123';
			service.init();
		});

		describe('captureRuntimeError', () => {
			it('should build correct event for http-alert channel', () => {
				const httpContext = {
					endpoint: '/api/webhook/alert',
					method: 'POST',
					statusCode: 500,
					requestId: 'req-123',
				};

				service.captureRuntimeError({
					channel: 'http-alert',
					error: new Error('Test HTTP error'),
					http: httpContext,
				});

				expect(Sentry.captureException).toHaveBeenCalledWith(
					expect.any(Error),
					expect.objectContaining({
						tags: expect.objectContaining({
							channel: 'http-alert',
							feature: 'alerts',
							error_type: 'runtime_error',
							is_process_level: 'false',
						}),
						contexts: expect.objectContaining({
							http: httpContext,
						}),
					}),
				);
			});

			it('should build correct event for news-monitor channel', () => {
				const newsContext = {
					symbolCount: 5,
					alertsSent: 2,
					summaryStatus: { analyzed: 3, cached: 1, timeout: 1, error: 0 },
				};

				service.captureRuntimeError({
					channel: 'news-monitor',
					error: new Error('Test news error'),
					news: newsContext,
				});

				expect(Sentry.captureException).toHaveBeenCalledWith(
					expect.any(Error),
					expect.objectContaining({
						tags: expect.objectContaining({
							channel: 'news-monitor',
							feature: 'news-monitor',
						}),
					}),
				);
			});

			it('should build correct event for telegram channel', () => {
				service.captureRuntimeError({
					channel: 'telegram',
					error: new Error('Telegram error'),
				});

				expect(Sentry.captureException).toHaveBeenCalledWith(
					expect.any(Error),
					expect.objectContaining({
						tags: expect.objectContaining({
							channel: 'telegram',
							feature: 'telegram-alerts',
						}),
					}),
				);
			});

			it('should build correct event for whatsapp channel', () => {
				service.captureRuntimeError({
					channel: 'whatsapp',
					error: new Error('WhatsApp error'),
				});

				expect(Sentry.captureException).toHaveBeenCalledWith(
					expect.any(Error),
					expect.objectContaining({
						tags: expect.objectContaining({
							channel: 'whatsapp',
							feature: 'whatsapp-alerts',
						}),
					}),
				);
			});

			it('should include alert context when provided', () => {
				const alertContext = {
					textLength: 150,
					hasEnrichment: true,
					enrichedSource: 'gemini-grounding',
					truncated: false,
				};

				service.captureRuntimeError({
					channel: 'http-alert',
					error: new Error('Alert error'),
					alert: alertContext,
				});

				expect(Sentry.captureException).toHaveBeenCalledWith(
					expect.any(Error),
					expect.objectContaining({
						contexts: expect.objectContaining({
							alert: {
								textLength: 150,
								hasEnrichment: true,
								enrichedSource: 'gemini-grounding',
								truncated: false,
							},
						}),
					}),
				);
			});
		});

		describe('captureExternalFailure', () => {
			it('should build correct event for external provider failure', () => {
				const externalContext = {
					provider: 'whatsapp-greenapi',
					attemptCount: 3,
					durationMs: 5000,
					lastErrorMessage: 'Connection timeout',
					lastErrorCode: 'ETIMEDOUT',
				};

				service.captureExternalFailure({
					channel: 'whatsapp',
					external: externalContext,
				});

				expect(Sentry.captureException).toHaveBeenCalledWith(
					expect.any(Error),
					expect.objectContaining({
						tags: expect.objectContaining({
							channel: 'whatsapp',
							error_type: 'external_failure',
						}),
						contexts: expect.objectContaining({
							external: externalContext,
						}),
					}),
				);
			});

			it('should set correct message format for external failure', () => {
				service.captureExternalFailure({
					channel: 'telegram',
					external: {
						provider: 'telegram-api',
						attemptCount: 2,
						durationMs: 3000,
					},
				});

				const capturedError = Sentry.captureException.mock.calls[0][0];
				expect(capturedError.message).toBe('External failure: telegram-api after 2 attempt(s)');
			});
		});

		describe('captureProcessError', () => {
			it('should build correct event for uncaughtException', () => {
				service.captureProcessError({
					error: new Error('Uncaught test error'),
					source: 'uncaughtException',
				});

				expect(Sentry.captureException).toHaveBeenCalledWith(
					expect.any(Error),
					expect.objectContaining({
						tags: expect.objectContaining({
							channel: 'process',
							feature: 'process',
							error_type: 'process_error',
							is_process_level: 'true',
						}),
						extra: expect.objectContaining({
							processErrorSource: 'uncaughtException',
						}),
					}),
				);
			});

			it('should build correct event for unhandledRejection', () => {
				service.captureProcessError({
					error: new Error('Unhandled rejection'),
					source: 'unhandledRejection',
				});

				expect(Sentry.captureException).toHaveBeenCalledWith(
					expect.any(Error),
					expect.objectContaining({
						extra: expect.objectContaining({
							processErrorSource: 'unhandledRejection',
						}),
					}),
				);
			});
		});
	});

	describe('FEATURE_NAMES mapping', () => {
		it('should have correct feature names for all channels', () => {
			expect(FEATURE_NAMES['http-alert']).toBe('alerts');
			expect(FEATURE_NAMES['news-monitor']).toBe('news-monitor');
			expect(FEATURE_NAMES['telegram']).toBe('telegram-alerts');
			expect(FEATURE_NAMES['whatsapp']).toBe('whatsapp-alerts');
			expect(FEATURE_NAMES['grounding']).toBe('gemini-grounding');
			expect(FEATURE_NAMES['news-enrichment']).toBe('news-enrichment');
			expect(FEATURE_NAMES['process']).toBe('process');
		});
	});

	describe('flush()', () => {
		it('should return true when monitoring is disabled', async () => {
			process.env.ENABLE_SENTRY = 'false';
			service.init();

			const result = await service.flush();
			expect(result).toBe(true);
			expect(Sentry.flush).not.toHaveBeenCalled();
		});

		it('should call Sentry.flush when enabled', async () => {
			process.env.ENABLE_SENTRY = 'true';
			process.env.SENTRY_DSN = 'https://key@sentry.io/123';
			service.init();

			await service.flush(3000);
			expect(Sentry.flush).toHaveBeenCalledWith(3000);
		});
	});
});
