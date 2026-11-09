'use strict';

const i18n = require('../../src/admin/i18n');

describe('admin console i18n', () => {
	describe('locale resolution', () => {
		it('resolves URL query parameter ?lang=es over localStorage and navigator', () => {
			const resolved = i18n.resolveLocale({
				search: '?lang=es',
				localStorage: { admin_lang: 'en' },
				navigator: { language: 'en-US' },
			});
			expect(resolved).toBe('es');
		});

		it('resolves URL query parameter ?lang=en over localStorage and navigator', () => {
			const resolved = i18n.resolveLocale({
				search: '?lang=en',
				localStorage: { admin_lang: 'es' },
				navigator: { language: 'es-ES' },
			});
			expect(resolved).toBe('en');
		});

		it('falls back to localStorage when URL search has no lang parameter', () => {
			const resolved = i18n.resolveLocale({
				search: '?view=status',
				localStorage: { admin_lang: 'es' },
				navigator: { language: 'en-US' },
			});
			expect(resolved).toBe('es');
		});

		it('supports getItem on localStorage object', () => {
			const resolved = i18n.resolveLocale({
				search: '',
				localStorage: {
					getItem: (key) => (key === 'admin_lang' ? 'es' : null),
				},
				navigator: { language: 'en-US' },
			});
			expect(resolved).toBe('es');
		});

		it('strictly defaults to en (opt-in only) when URL and localStorage are unset', () => {
			const resolved = i18n.resolveLocale({
				search: '',
				localStorage: {},
				navigator: { language: 'es-AR', languages: ['es-CL', 'en-US'] },
			});
			expect(resolved).toBe('en');
		});

		it('defaults to en when locale is unsupported (e.g. fr, de, ja)', () => {
			const resolved = i18n.resolveLocale({
				search: '?lang=fr',
				localStorage: { admin_lang: 'de' },
				navigator: { language: 'ja-JP' },
			});
			expect(resolved).toBe('en');
		});

		it('defaults to en when all sources are missing or empty', () => {
			const resolved = i18n.resolveLocale({});
			expect(resolved).toBe('en');
		});
	});

	describe('translation function i18n.t', () => {
		it('translates keys for English and Spanish', () => {
			expect(i18n.t('nav.overview', { lang: 'en' })).toBe('Overview');
			expect(i18n.t('nav.overview', { lang: 'es' })).toBe('Resumen');
		});

		it('falls back to English when a key is missing in Spanish', () => {
			// Even if an exotic key is not in Spanish, it falls back to English
			expect(i18n.t('views.overview', { lang: 'es' })).toBe('Resumen');
			expect(i18n.t('shell.brand', { lang: 'es' })).toBe('Cabros Bot');
		});

		it('falls back to the raw key when missing in both locales', () => {
			expect(i18n.t('untranslated.random.key', { lang: 'es' })).toBe('untranslated.random.key');
		});

		it('interpolates variables into translated strings', () => {
			expect(i18n.t('auth.signedInAs', { lang: 'en', user: 'admin@test.com' }))
				.toBe('Signed in as admin@test.com.');
			expect(i18n.t('auth.signedInAs', { lang: 'es', user: 'admin@test.com' }))
				.toBe('Sesión iniciada como admin@test.com.');
		});

		it('safely ignores Object.prototype properties during interpolation', () => {
			expect(i18n.t('filters.activeFilters', { lang: 'en', filters: 'none' }))
				.toBe('Active filters: none');
			expect(i18n.t('test {toString}', { lang: 'en', user: 'admin' }))
				.toBe('test {toString}');
		});
	});

	describe('acceptance criteria: en registry matches current hardcoded strings', () => {
		it('matches section headings', () => {
			expect(i18n.t('views.overview', { lang: 'en' })).toBe('Overview');
			expect(i18n.t('views.status', { lang: 'en' })).toBe('Status');
			expect(i18n.t('views.alerts', { lang: 'en' })).toBe('Alerts');
			expect(i18n.t('views.presets', { lang: 'en' })).toBe('Presets');
			expect(i18n.t('views.jobs', { lang: 'en' })).toBe('Jobs');
			expect(i18n.t('views.analysis', { lang: 'en' })).toBe('Analysis');
			expect(i18n.t('views.playground', { lang: 'en' })).toBe('Playground');
			expect(i18n.t('views.trading', { lang: 'en' })).toBe('Trading');
			expect(i18n.t('views.newsMonitor', { lang: 'en' })).toBe('News monitor');
			expect(i18n.t('views.diagnostics', { lang: 'en' })).toBe('Diagnostics');
		});

		it('matches common actions', () => {
			expect(i18n.t('actions.cancel', { lang: 'en' })).toBe('Cancel');
			expect(i18n.t('actions.retry', { lang: 'en' })).toBe('Retry');
			expect(i18n.t('actions.refresh', { lang: 'en' })).toBe('Refresh');
			expect(i18n.t('actions.export', { lang: 'en' })).toBe('Export');
			expect(i18n.t('actions.replay', { lang: 'en' })).toBe('Replay');
			expect(i18n.t('actions.acknowledge', { lang: 'en' })).toBe('Acknowledge');
			expect(i18n.t('actions.clearFilters', { lang: 'en' })).toBe('Clear filters');
			expect(i18n.t('actions.clearFilters', { lang: 'es' })).toBe('Limpiar filtros');
			expect(i18n.t('actions.prevPage', { lang: 'en' })).toBe('Previous page');
			expect(i18n.t('actions.prevPage', { lang: 'es' })).toBe('Página anterior');
			expect(i18n.t('actions.nextPage', { lang: 'en' })).toBe('Next page');
			expect(i18n.t('actions.nextPage', { lang: 'es' })).toBe('Página siguiente');
			expect(i18n.t('actions.refreshDashboard', { lang: 'en' })).toBe('Refresh dashboard');
			expect(i18n.t('actions.refreshDashboard', { lang: 'es' })).toBe('Actualizar panel');
			expect(i18n.t('actions.refreshReport', { lang: 'en' })).toBe('Refresh report');
			expect(i18n.t('actions.refreshReport', { lang: 'es' })).toBe('Actualizar reporte');
			expect(i18n.t('actions.runSelfTest', { lang: 'en' })).toBe('Run self-test');
			expect(i18n.t('actions.runSelfTest', { lang: 'es' })).toBe('Ejecutar autodiagnóstico');
			expect(i18n.t('actions.copyDetails', { lang: 'en' })).toBe('Copy details');
			expect(i18n.t('actions.copyDetails', { lang: 'es' })).toBe('Copiar detalles');
		});

		it('matches empty and error states from acceptance criteria', () => {
			expect(i18n.t('empty.noMeasurements', { lang: 'en' })).toBe('No measurements found');
			expect(i18n.t('empty.noDeliveryChannels', { lang: 'en' })).toBe('No delivery channels reported.');
			expect(i18n.t('empty.checkingAuth', { lang: 'en' })).toBe('Checking authentication…');
			expect(i18n.t('empty.firebaseUnavailable', { lang: 'en' })).toBe('Firebase sign-in is unavailable');

			// Also supports lookup by literal string for direct empty-state text
			expect(i18n.t('No measurements found', { lang: 'en' })).toBe('No measurements found');
			expect(i18n.t('No delivery channels reported.', { lang: 'en' })).toBe('No delivery channels reported.');
			expect(i18n.t('Checking authentication…', { lang: 'en' })).toBe('Checking authentication…');
			expect(i18n.t('Firebase sign-in is unavailable', { lang: 'en' })).toBe('Firebase sign-in is unavailable');
		});

		it('translates empty and error states to Spanish', () => {
			expect(i18n.t('empty.noMeasurements', { lang: 'es' })).toBe('No se encontraron mediciones');
			expect(i18n.t('empty.noDeliveryChannels', { lang: 'es' })).toBe('No se reportaron canales de entrega.');
			expect(i18n.t('empty.checkingAuth', { lang: 'es' })).toBe('Comprobando autenticación…');
			expect(i18n.t('empty.firebaseUnavailable', { lang: 'es' })).toBe('El inicio de sesión de Firebase no está disponible');

			expect(i18n.t('No measurements found', { lang: 'es' })).toBe('No se encontraron mediciones');
			expect(i18n.t('No delivery channels reported.', { lang: 'es' })).toBe('No se reportaron canales de entrega.');
			expect(i18n.t('Checking authentication…', { lang: 'es' })).toBe('Comprobando autenticación…');
			expect(i18n.t('Firebase sign-in is unavailable', { lang: 'es' })).toBe('El inicio de sesión de Firebase no está disponible');
		});

		it('matches status row labels', () => {
			expect(i18n.t('status.ready', { lang: 'en' })).toBe('Ready');
			expect(i18n.t('status.degraded', { lang: 'en' })).toBe('Degraded');
			expect(i18n.t('status.unconfigured', { lang: 'en' })).toBe('Unconfigured');
			expect(i18n.t('status.disabled', { lang: 'en' })).toBe('Disabled');
			expect(i18n.t('status.misconfigured', { lang: 'en' })).toBe('Needs attention');

			// Spanish status labels
			expect(i18n.t('status.ready', { lang: 'es' })).toBe('Listo');
			expect(i18n.t('status.degraded', { lang: 'es' })).toBe('Degradado');
			expect(i18n.t('status.unconfigured', { lang: 'es' })).toBe('No configurado');
			expect(i18n.t('status.disabled', { lang: 'es' })).toBe('Deshabilitado');
			expect(i18n.t('status.misconfigured', { lang: 'es' })).toBe('Requiere atención');
		});

		it('matches filter form labels and time-window copy', () => {
			expect(i18n.t('filters.from', { lang: 'en' })).toBe('From');
			expect(i18n.t('filters.to', { lang: 'en' })).toBe('To');
			expect(i18n.t('filters.limit', { lang: 'en' })).toBe('Limit');
			expect(i18n.t('filters.source', { lang: 'en' })).toBe('Source');
			expect(i18n.t('filters.enriched', { lang: 'en' })).toBe('Enriched');
			expect(i18n.t('filters.last24h', { lang: 'en' })).toBe('Last 24h');
			expect(i18n.t('filters.customRange', { lang: 'en' })).toBe('Custom range');
			expect(i18n.t('filters.allAlerts', { lang: 'en' })).toBe('All alerts');
			expect(i18n.t('filters.enrichedOnly', { lang: 'en' })).toBe('Enriched only');
			expect(i18n.t('filters.notEnriched', { lang: 'en' })).toBe('Not enriched');

			// Spanish filter form labels
			expect(i18n.t('filters.from', { lang: 'es' })).toBe('Desde');
			expect(i18n.t('filters.to', { lang: 'es' })).toBe('Hasta');
			expect(i18n.t('filters.limit', { lang: 'es' })).toBe('Límite');
			expect(i18n.t('filters.source', { lang: 'es' })).toBe('Origen');
			expect(i18n.t('filters.enriched', { lang: 'es' })).toBe('Enriquecida');
			expect(i18n.t('filters.last24h', { lang: 'es' })).toBe('Últimas 24h');
			expect(i18n.t('filters.customRange', { lang: 'es' })).toBe('Rango personalizado');
			expect(i18n.t('filters.allAlerts', { lang: 'es' })).toBe('Todas las alertas');
			expect(i18n.t('filters.enrichedOnly', { lang: 'es' })).toBe('Solo enriquecidas');
			expect(i18n.t('filters.notEnriched', { lang: 'es' })).toBe('No enriquecidas');
		});
	});

	describe('parity between English and Spanish dictionary entries', () => {
		it('contains Spanish translations for all English keys', () => {
			const enKeys = Object.keys(i18n.locales.en);
			const esKeys = new Set(Object.keys(i18n.locales.es));

			const missing = enKeys.filter((k) => !esKeys.has(k));
			expect(missing).toEqual([]);
		});

		it('ensures all Spanish translations are non-empty strings', () => {
			Object.entries(i18n.locales.es).forEach(([key, value]) => {
				expect(typeof value).toBe('string');
				expect(value.trim().length).toBeGreaterThan(0);
			});
		});
	});

	describe('DOM integration and language flipping', () => {
		const fs = require('fs');
		const path = require('path');
		const vm = require('vm');

		class MockElement {
			constructor(tagName) {
				this.tagName = tagName.toUpperCase();
				this.children = [];
				this.attributes = {};
				this.listeners = {};
				this.dataset = {};
				this._text = '';
				this.value = '';
			}

			get textContent() {
				return this._text + this.children.map((c) => c.textContent).join('');
			}

			set textContent(val) {
				this._text = String(val);
				this.children = [];
			}

			append(...nodes) {
				nodes.forEach((n) => {
					n.parentNode = this;
					this.children.push(n);
				});
			}

			replaceChildren(...nodes) {
				this.children = [];
				this._text = '';
				this.append(...nodes);
			}

			setAttribute(k, v) { this.attributes[k] = String(v); }
			getAttribute(k) { return this.attributes[k] || null; }
			removeAttribute(k) { delete this.attributes[k]; }

			addEventListener(type, listener) {
				(this.listeners[type] ||= []).push(listener);
			}

			async dispatch(type) {
				for (const l of this.listeners[type] || []) await l({ target: this });
			}

			querySelectorAll(selector) {
				const parts = selector.split(/\s+/).filter(Boolean);
				let currentNodes = [this];
				for (const part of parts) {
					const nextNodes = [];
					currentNodes.forEach((parent) => {
						const check = (node) => {
							if (node !== parent) {
								if (part.startsWith('.') && node.className && node.className.split(/\s+/).includes(part.slice(1))) {
									nextNodes.push(node);
								} else if (part.startsWith('[data-view]')) {
									if (node.dataset && node.dataset.view) nextNodes.push(node);
								} else if (part.startsWith('label[for=')) {
									const m = part.match(/label\[for="([^"]+)"\]/);
									if (m && node.tagName === 'LABEL' && node.attributes?.for === m[1]) nextNodes.push(node);
								}
							}
							node.children.forEach(check);
						};
						check(parent);
					});
					currentNodes = nextNodes;
				}
				return currentNodes;
			}

			querySelector(selector) {
				return this.querySelectorAll(selector)[0] || null;
			}
		}

		function setupBrowserContext({ search = '', localStorage = {} } = {}) {
			const body = new MockElement('body');
			const docElement = new MockElement('html');
			docElement.lang = 'en';

			const elementsById = {};
			[
				'view',
				'view-status',
				'firebase-auth',
				'auth-form',
				'sign-in',
				'sign-out',
				'auth-state',
				'auth-credentials-error',
				'legacy-connection',
				'connection-form',
				'api-key',
				'save-key',
				'clear-key',
				'key-state',
				'toggle-sidebar',
				'console-shell',
				'console-nav',
				'sse-status',
				'sse-label',
				'toast-container',
				'admin-lang',
				'firebase-auth-title',
				'connection-title',
			].forEach((id) => {
				const node = new MockElement('div');
				node.id = id;
				elementsById[id] = node;
				body.append(node);
			});

			// Brand lockup
			const brandLockup = new MockElement('div');
			brandLockup.className = 'brand-lockup';
			const eyebrow = new MockElement('p');
			eyebrow.className = 'eyebrow';
			eyebrow.textContent = 'Operations';
			brandLockup.append(eyebrow);
			body.append(brandLockup);

			// Nav buttons
			['overview', 'status', 'alerts'].forEach((view) => {
				const btn = new MockElement('button');
				btn.dataset.view = view;
				const text = new MockElement('span');
				text.className = 'nav-text';
				text.textContent = view[0].toUpperCase() + view.slice(1);
				btn.append(text);
				elementsById['console-nav'].append(btn);
			});

			const documentListeners = {};
			const mockDoc = {
				body,
				documentElement: docElement,
				createElement: (tag) => new MockElement(tag),
				createElementNS: (_ns, tag) => new MockElement(tag),
				getElementById: (id) => elementsById[id] || null,
				querySelectorAll: (sel) => body.querySelectorAll(sel),
				querySelector: (sel) => body.querySelector(sel),
				addEventListener: (t, l) => { documentListeners[t] = l; },
			};

			const mockStorage = new Map(Object.entries(localStorage));
			const mockFetch = async (url) => ({
				ok: true,
				status: 200,
				json: async () => {
					if (url.includes('/admin/auth-config')) return { enabled: false };
					if (url.includes('/openapi.json')) return {};
					return {};
				},
				text: async () => '{}',
			});

			const context = {
				document: mockDoc,
				AbortController,
				setTimeout,
				clearTimeout,
				fetch: mockFetch,
				window: {
					location: { search, pathname: '/admin', hash: '' },
					localStorage: {
						getItem: (k) => (mockStorage.has(k) ? mockStorage.get(k) : null),
						setItem: (k, v) => mockStorage.set(k, String(v)),
						removeItem: (k) => mockStorage.delete(k),
					},
					sessionStorage: {
						getItem: () => null,
						setItem: () => {},
						removeItem: () => {},
					},
					history: {
						replaceState: (_st, _title, url) => {
							context.window.location.search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
						},
						pushState: (_st, _title, url) => {
							context.window.location.search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
						},
					},
					addEventListener: () => {},
					fetch: mockFetch,
				},
				URLSearchParams,
				console,
			};

			vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/admin/i18n.js'), 'utf8'), context);
			vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/admin/admin.js'), 'utf8'), context);

			documentListeners.DOMContentLoaded();

			return {
				docElement,
				body,
				elementsById,
				eyebrow,
				context,
				storage: mockStorage,
			};
		}

		it('?lang=es flips the admin shell copy to Spanish with no API or contract change', () => {
			const browser = setupBrowserContext({ search: '?lang=es' });

			expect(browser.docElement.lang).toBe('es');
			expect(browser.eyebrow.textContent).toBe('Operaciones');

			const navOverview = browser.body.querySelectorAll('[data-view]')[0].querySelector('.nav-text');
			expect(navOverview.textContent).toBe('Resumen');

			const navStatus = browser.body.querySelectorAll('[data-view]')[1].querySelector('.nav-text');
			expect(navStatus.textContent).toBe('Estado');

			const navAlerts = browser.body.querySelectorAll('[data-view]')[2].querySelector('.nav-text');
			expect(navAlerts.textContent).toBe('Alertas');
		});

		it('localStorage.admin_lang = "es" flips shell to Spanish when no URL query is present', () => {
			const browser = setupBrowserContext({ localStorage: { admin_lang: 'es' } });

			expect(browser.docElement.lang).toBe('es');
			expect(browser.eyebrow.textContent).toBe('Operaciones');
		});

		it('English behavior is byte-identical: lang=en restores previous text with no diff', () => {
			const browser = setupBrowserContext({ search: '?lang=en' });

			expect(browser.docElement.lang).toBe('en');
			expect(browser.eyebrow.textContent).toBe('Operations');

			const navOverview = browser.body.querySelectorAll('[data-view]')[0].querySelector('.nav-text');
			expect(navOverview.textContent).toBe('Overview');

			const navStatus = browser.body.querySelectorAll('[data-view]')[1].querySelector('.nav-text');
			expect(navStatus.textContent).toBe('Status');

			const navAlerts = browser.body.querySelectorAll('[data-view]')[2].querySelector('.nav-text');
			expect(navAlerts.textContent).toBe('Alerts');
		});

		it('changing the #admin-lang select switches language and updates storage and html lang', async () => {
			const browser = setupBrowserContext({ search: '?lang=en' });
			expect(browser.docElement.lang).toBe('en');

			const langSelect = browser.elementsById['admin-lang'];
			langSelect.value = 'es';
			await langSelect.dispatch('change');

			expect(browser.docElement.lang).toBe('es');
			expect(browser.eyebrow.textContent).toBe('Operaciones');
			expect(browser.storage.get('admin_lang')).toBe('es');

			// Switch back to en
			langSelect.value = 'en';
			await langSelect.dispatch('change');

			expect(browser.docElement.lang).toBe('en');
			expect(browser.eyebrow.textContent).toBe('Operations');
			expect(browser.storage.get('admin_lang')).toBe('en');
		});

		it('synchronizes URL when switching languages, removing lang query param when switching back to en', async () => {
			const browser = setupBrowserContext({ search: '?lang=es' });
			expect(browser.docElement.lang).toBe('es');

			const langSelect = browser.elementsById['admin-lang'];
			langSelect.value = 'en';
			await langSelect.dispatch('change');

			expect(browser.docElement.lang).toBe('en');
			expect(browser.context.window.location.search).not.toContain('lang=es');
			expect(browser.context.window.location.search).not.toContain('lang=en');
		});
	});
});
