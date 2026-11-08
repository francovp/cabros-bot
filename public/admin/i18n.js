'use strict';

/* global module, window, document, globalThis, URLSearchParams */

(function exposeI18n(root, factory) {
	const api = factory();

	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	}

	root.CabrosAdminI18n = api;
	root.i18n = api;
}(typeof window === 'undefined' ? globalThis : window, () => {
	const SUPPORTED_LOCALES = ['en', 'es'];
	const DEFAULT_LOCALE = 'en';

	const en = {
		// Shell & Navigation
		'shell.brand': 'Cabros Bot',
		'shell.operations': 'Operations',
		'shell.workspace': 'Workspace',
		'shell.sidebarNote': 'Workspace · Cabros Bot',
		'shell.operatorWorkspace': 'Operator workspace',
		'shell.topbarTitle': 'Your operations, at a glance',
		'shell.collapseSidebar': 'Collapse sidebar',
		'shell.expandSidebar': 'Expand sidebar',
		'shell.clearKey': 'Clear key',
		'shell.skipToWorkspace': 'Skip to workspace',
		'shell.viewSuffix': 'view',

		// Nav button labels
		'nav.overview': 'Overview',
		'nav.status': 'Status',
		'nav.diagnostics': 'Diagnostics',
		'nav.alerts': 'Alerts',
		'nav.outcomes': 'Outcomes',
		'nav.presets': 'Presets',
		'nav.subscribers': 'Subscribers',
		'nav.jobs': 'Jobs',
		'nav.orders': 'Orders',
		'nav.analysis': 'Analysis',
		'nav.trading': 'Trading',
		'nav.newsMonitor': 'News monitor',
		'nav.playground': 'Operations',

		// Section View Titles
		'views.overview': 'Overview',
		'views.operationalOverview': 'Operational overview',
		'views.status': 'Status',
		'views.diagnostics': 'Diagnostics',
		'views.trading': 'Trading',
		'views.alerts': 'Alerts',
		'views.outcomes': 'Outcomes',
		'views.presets': 'Presets',
		'views.subscribers': 'Subscribers',
		'views.jobs': 'Jobs',
		'views.orders': 'Orders',
		'views.analysis': 'Analysis',
		'views.newsMonitor': 'News monitor',
		'views.playground': 'Playground',

		// Auth card
		'auth.eyebrow': 'Authentication',
		'auth.adminSignIn': 'Admin sign-in',
		'auth.email': 'Email',
		'auth.password': 'Password',
		'auth.signIn': 'Sign in',
		'auth.signOut': 'Sign out',
		'auth.checkingConfig': 'Checking sign-in configuration…',
		'auth.checkingAuth': 'Checking authentication…',
		'auth.sessionAccess': 'Session access',
		'auth.sessionOnly': 'Session-only',
		'auth.apiKey': 'API key',
		'auth.useKeyForSession': 'Use key for this session',
		'auth.firebaseUnavailable': 'Firebase sign-in is unavailable',
		'auth.signedInAs': 'Signed in as {user}.',
		'auth.signInToContinue': 'Sign in to continue.',
		'auth.signInRequired': 'Sign in required.',
		'auth.unauthorized': 'This account is not authorized for the admin console.',
		'auth.unableToVerify': 'Unable to verify the signed-in account.',

		// SSE Stream
		'sse.offline': 'Offline',
		'sse.live': 'Live',
		'sse.connecting': 'Connecting…',

		// Common Actions
		'actions.cancel': 'Cancel',
		'actions.retry': 'Retry',
		'actions.refresh': 'Refresh',
		'actions.export': 'Export',
		'actions.replay': 'Replay',
		'actions.acknowledge': 'Acknowledge',
		'actions.cancelJob': 'Cancel job',
		'actions.retryJob': 'Retry job',
		'actions.retryFailed': 'Retry failed items',
		'actions.retrySubmission': 'Retry submission',
		'actions.refreshStatus': 'Refresh status',
		'actions.refreshReport': 'Refresh report',
		'actions.refreshDashboard': 'Refresh dashboard',
		'actions.refreshTrading': 'Refresh trading data',
		'actions.exportAlerts': 'Export alerts',
		'actions.exportSelected': 'Export selected',
		'actions.replayAlert': 'Replay alert',
		'actions.replaySelected': 'Replay selected',
		'actions.runPreset': 'Run preset',
		'actions.deletePreset': 'Delete preset',
		'actions.runSelfTest': 'Run self-test',
		'actions.copyDetails': 'Copy details',
		'actions.clearFilters': 'Clear filters',
		'actions.prevPage': 'Previous page',
		'actions.nextPage': 'Next page',

		// Empty and Error States
		'empty.noMeasurements': 'No measurements found',
		'empty.noDeliveryChannels': 'No delivery channels reported.',
		'empty.checkingAuth': 'Checking authentication…',
		'empty.firebaseUnavailable': 'Firebase sign-in is unavailable',
		'empty.firebaseUnavailableDetail': 'Firebase sign-in is unavailable. Ask an administrator to configure it.',
		'empty.noDependencies': 'No dependencies reported.',
		'empty.noDependenciesMatch': 'No dependencies match these filters.',
		'empty.noFeatureFlags': 'No feature flags are enabled.',
		'empty.enterApiKeyForStatus': 'Enter an API key to load live status.',
		'empty.noStoredAlerts': 'No stored alerts match these filters.',
		'empty.noRecordedOutcomes': 'No recorded outcomes match these filters.',
		'empty.noScannerPresets': 'No scanner presets found.',
		'empty.noAlertSubscribers': 'No alert subscribers found.',
		'empty.noRecentJobs': 'No recent jobs found.',
		'empty.noRecentOrders': 'No recent orders found.',
		'empty.noOpenPositions': 'No open positions recorded.',
		'empty.noOrderMutations': 'No order mutations recorded yet.',
		'empty.noEvents': 'No events yet — connect a key or sign in to stream.',
		'empty.loadingContract': 'Loading API contract…',
		'empty.requestInProgress': 'Request in progress…',
		'empty.statusUnavailable': 'Status unavailable.',
		'empty.statusUnavailableDetail': 'Status unavailable. Check the API key and service logs.',

		// Status Row Labels
		'status.ready': 'Ready',
		'status.degraded': 'Degraded',
		'status.unconfigured': 'Unconfigured',
		'status.disabled': 'Disabled',
		'status.misconfigured': 'Needs attention',
		'status.unknown': 'Unknown',
		'status.attention': 'Needs attention',
		'status.all': 'All statuses',
		'status.eyebrow': 'Runtime status',
		'status.description': 'Inspect dependency readiness, delivery channels and worker health.',
		'status.searchPlaceholder': 'Name, provider or status',
		'status.deliveryChannels': 'Delivery channels',
		'status.dependencyFilters': 'Dependency filters',
		'status.dependencyHealth': 'Dependency health',
		'status.enabledCapabilities': 'Enabled capabilities',
		'status.waitingLive': 'Waiting for live status…',
		'status.loadingLive': 'Loading live status…',
		'status.noResponse': 'No status response yet.',
		'status.responseDetails': 'Response details',

		// Filter Form Labels & Time-Window Copy
		'filters.from': 'From',
		'filters.to': 'To',
		'filters.limit': 'Limit',
		'filters.source': 'Source',
		'filters.enriched': 'Enriched',
		'filters.allAlerts': 'All alerts',
		'filters.enrichedOnly': 'Enriched only',
		'filters.notEnriched': 'Not enriched',
		'filters.allSources': 'All sources',
		'filters.before': 'Before cursor',
		'filters.beforeCursor': 'Before cursor',
		'filters.activeFilters': 'Active filters: {filters}',
		'filters.activeFiltersNone': 'Active filters: none',
		'filters.searchDependencies': 'Search dependencies',
		'filters.filterByStatus': 'Filter by status',
		'filters.allStatuses': 'All statuses',
		'filters.allWindows': 'All windows',
		'filters.pending': 'Pending',
		'filters.evaluated': 'Evaluated',
		'filters.unavailable': 'Unavailable',
		'filters.last24h': 'Last 24h',
		'filters.customRange': 'Custom range',

		// Literal string aliases for direct t(literal) calls
		'No measurements found': 'No measurements found',
		'No delivery channels reported.': 'No delivery channels reported.',
		'Checking authentication…': 'Checking authentication…',
		'Firebase sign-in is unavailable': 'Firebase sign-in is unavailable',
		'Firebase sign-in is unavailable. Ask an administrator to configure it.': 'Firebase sign-in is unavailable. Ask an administrator to configure it.',
		'Status unavailable.': 'Status unavailable.',
		'Status unavailable. Check the API key and service logs.': 'Status unavailable. Check the API key and service logs.',
		'No dependencies reported.': 'No dependencies reported.',
		'No dependencies match these filters.': 'No dependencies match these filters.',
		'No feature flags are enabled.': 'No feature flags are enabled.',
		'Enter an API key to load live status.': 'Enter an API key to load live status.',
		'No stored alerts match these filters.': 'No stored alerts match these filters.',
		'No recorded outcomes match these filters.': 'No recorded outcomes match these filters.',
		'No scanner presets found.': 'No scanner presets found.',
		'No alert subscribers found.': 'No alert subscribers found.',
		'No recent jobs found.': 'No recent jobs found.',
		'No recent orders found.': 'No recent orders found.',
		'No open positions recorded.': 'No open positions recorded.',
		'No order mutations recorded yet.': 'No order mutations recorded yet.',
		'No events yet — connect a key or sign in to stream.': 'No events yet — connect a key or sign in to stream.',
		'Loading API contract…': 'Loading API contract…',
		'Request in progress…': 'Request in progress…',
		'Waiting for live status…': 'Waiting for live status…',
		'Loading live status…': 'Loading live status…',
		'No status response yet.': 'No status response yet.',
		'Response details': 'Response details',
		'Sign in to continue.': 'Sign in to continue.',
		'Sign in required.': 'Sign in required.',
		'This account is not authorized for the admin console.': 'This account is not authorized for the admin console.',
		'Unable to verify the signed-in account.': 'Unable to verify the signed-in account.',
		'Previous page': 'Previous page',
		'Next page': 'Next page',
		'Clear filters': 'Clear filters',
		'Refresh dashboard': 'Refresh dashboard',
		'Refresh report': 'Refresh report',
		'Run self-test': 'Run self-test',
		'Copy details': 'Copy details',
		'Operational overview': 'Operational overview',
		'Limit': 'Limit',
		'Before cursor': 'Before cursor',
		'From': 'From',
		'To': 'To',
		'Source': 'Source',
		'Enriched': 'Enriched',
		'Symbol': 'Symbol',
		'Exchange': 'Exchange',
		'Status': 'Status',
		'Window': 'Window',
		'All alerts': 'All alerts',
		'Enriched only': 'Enriched only',
		'Not enriched': 'Not enriched',
		'All sources': 'All sources',
		'All statuses': 'All statuses',
		'All windows': 'All windows',
		'Pending': 'Pending',
		'Evaluated': 'Evaluated',
		'Unavailable': 'Unavailable',
		'Active filters: none': 'Active filters: none',
		'Ready': 'Ready',
		'Disabled': 'Disabled',
		'Degraded': 'Degraded',
		'Unconfigured': 'Unconfigured',
		'Needs attention': 'Needs attention',
		'Unknown': 'Unknown',
	};

	const es = {
		// Shell & Navigation
		'shell.brand': 'Cabros Bot',
		'shell.operations': 'Operaciones',
		'shell.workspace': 'Espacio de trabajo',
		'shell.sidebarNote': 'Espacio de trabajo · Cabros Bot',
		'shell.operatorWorkspace': 'Espacio de trabajo del operador',
		'shell.topbarTitle': 'Tus operaciones, de un vistazo',
		'shell.collapseSidebar': 'Colapsar barra lateral',
		'shell.expandSidebar': 'Expandir barra lateral',
		'shell.clearKey': 'Borrar clave',
		'shell.skipToWorkspace': 'Saltar al espacio de trabajo',
		'shell.viewSuffix': 'vista',

		// Nav button labels
		'nav.overview': 'Resumen',
		'nav.status': 'Estado',
		'nav.diagnostics': 'Diagnósticos',
		'nav.alerts': 'Alertas',
		'nav.outcomes': 'Resultados',
		'nav.presets': 'Plantillas',
		'nav.subscribers': 'Suscriptores',
		'nav.jobs': 'Tareas',
		'nav.orders': 'Órdenes',
		'nav.analysis': 'Análisis',
		'nav.trading': 'Trading',
		'nav.newsMonitor': 'Monitor de noticias',
		'nav.playground': 'Operaciones',

		// Section View Titles
		'views.overview': 'Resumen',
		'views.operationalOverview': 'Resumen operativo',
		'views.status': 'Estado',
		'views.diagnostics': 'Diagnósticos',
		'views.trading': 'Trading',
		'views.alerts': 'Alertas',
		'views.outcomes': 'Resultados',
		'views.presets': 'Plantillas',
		'views.subscribers': 'Suscriptores',
		'views.jobs': 'Tareas',
		'views.orders': 'Órdenes',
		'views.analysis': 'Análisis',
		'views.newsMonitor': 'Monitor de noticias',
		'views.playground': 'Área de pruebas',

		// Auth card
		'auth.eyebrow': 'Autenticación',
		'auth.adminSignIn': 'Inicio de sesión de administrador',
		'auth.email': 'Correo electrónico',
		'auth.password': 'Contraseña',
		'auth.signIn': 'Iniciar sesión',
		'auth.signOut': 'Cerrar sesión',
		'auth.checkingConfig': 'Comprobando configuración de inicio de sesión…',
		'auth.checkingAuth': 'Comprobando autenticación…',
		'auth.sessionAccess': 'Acceso de sesión',
		'auth.sessionOnly': 'Solo sesión',
		'auth.apiKey': 'Clave API',
		'auth.useKeyForSession': 'Usar clave para esta sesión',
		'auth.firebaseUnavailable': 'El inicio de sesión de Firebase no está disponible',
		'auth.signedInAs': 'Sesión iniciada como {user}.',
		'auth.signInToContinue': 'Inicia sesión para continuar.',
		'auth.signInRequired': 'Inicio de sesión requerido.',
		'auth.unauthorized': 'Esta cuenta no está autorizada para la consola de administración.',
		'auth.unableToVerify': 'No se pudo verificar la cuenta iniciada.',

		// SSE Stream
		'sse.offline': 'Desconectado',
		'sse.live': 'En vivo',
		'sse.connecting': 'Conectando…',

		// Common Actions
		'actions.cancel': 'Cancelar',
		'actions.retry': 'Reintentar',
		'actions.refresh': 'Actualizar',
		'actions.export': 'Exportar',
		'actions.replay': 'Repetir',
		'actions.acknowledge': 'Confirmar',
		'actions.cancelJob': 'Cancelar tarea',
		'actions.retryJob': 'Reintentar tarea',
		'actions.retryFailed': 'Reintentar elementos fallidos',
		'actions.retrySubmission': 'Reintentar envío',
		'actions.refreshStatus': 'Actualizar estado',
		'actions.refreshReport': 'Actualizar reporte',
		'actions.refreshDashboard': 'Actualizar panel',
		'actions.refreshTrading': 'Actualizar datos de trading',
		'actions.exportAlerts': 'Exportar alertas',
		'actions.exportSelected': 'Exportar seleccionados',
		'actions.replayAlert': 'Repetir alerta',
		'actions.replaySelected': 'Repetir seleccionadas',
		'actions.runPreset': 'Ejecutar plantilla',
		'actions.deletePreset': 'Eliminar plantilla',
		'actions.runSelfTest': 'Ejecutar autodiagnóstico',
		'actions.copyDetails': 'Copiar detalles',
		'actions.clearFilters': 'Limpiar filtros',
		'actions.prevPage': 'Página anterior',
		'actions.nextPage': 'Página siguiente',

		// Empty and Error States
		'empty.noMeasurements': 'No se encontraron mediciones',
		'empty.noDeliveryChannels': 'No se reportaron canales de entrega.',
		'empty.checkingAuth': 'Comprobando autenticación…',
		'empty.firebaseUnavailable': 'El inicio de sesión de Firebase no está disponible',
		'empty.firebaseUnavailableDetail': 'El inicio de sesión de Firebase no está disponible. Pide a un administrador que lo configure.',
		'empty.noDependencies': 'No se reportaron dependencias.',
		'empty.noDependenciesMatch': 'Ninguna dependencia coincide con estos filtros.',
		'empty.noFeatureFlags': 'No hay banderas de características habilitadas.',
		'empty.enterApiKeyForStatus': 'Ingresa una clave API para cargar el estado en vivo.',
		'empty.noStoredAlerts': 'Ninguna alerta almacenada coincide con estos filtros.',
		'empty.noRecordedOutcomes': 'Ningún resultado registrado coincide con estos filtros.',
		'empty.noScannerPresets': 'No se encontraron plantillas de escaneo.',
		'empty.noAlertSubscribers': 'No se encontraron suscriptores de alertas.',
		'empty.noRecentJobs': 'No se encontraron tareas recientes.',
		'empty.noRecentOrders': 'No se encontraron órdenes recientes.',
		'empty.noOpenPositions': 'No hay posiciones abiertas registradas.',
		'empty.noOrderMutations': 'No se han registrado mutaciones de órdenes aún.',
		'empty.noEvents': 'Sin eventos aún — conecta una clave o inicia sesión para transmitir.',
		'empty.loadingContract': 'Cargando contrato de API…',
		'empty.requestInProgress': 'Solicitud en curso…',
		'empty.statusUnavailable': 'Estado no disponible.',
		'empty.statusUnavailableDetail': 'Estado no disponible. Revisa la clave API y los registros del servicio.',

		// Status Row Labels
		'status.ready': 'Listo',
		'status.degraded': 'Degradado',
		'status.unconfigured': 'No configurado',
		'status.disabled': 'Deshabilitado',
		'status.misconfigured': 'Requiere atención',
		'status.unknown': 'Desconocido',
		'status.attention': 'Requiere atención',
		'status.all': 'Todos los estados',
		'status.eyebrow': 'Estado de ejecución',
		'status.description': 'Inspecciona la disponibilidad de dependencias, canales de entrega y salud de los workers.',
		'status.searchPlaceholder': 'Nombre, proveedor o estado',
		'status.deliveryChannels': 'Canales de entrega',
		'status.dependencyFilters': 'Filtros de dependencias',
		'status.dependencyHealth': 'Salud de dependencias',
		'status.enabledCapabilities': 'Capacidades habilitadas',
		'status.waitingLive': 'Esperando estado en vivo…',
		'status.loadingLive': 'Cargando estado en vivo…',
		'status.noResponse': 'Sin respuesta de estado aún.',
		'status.responseDetails': 'Detalles de respuesta',

		// Filter Form Labels & Time-Window Copy
		'filters.from': 'Desde',
		'filters.to': 'Hasta',
		'filters.limit': 'Límite',
		'filters.source': 'Origen',
		'filters.enriched': 'Enriquecida',
		'filters.allAlerts': 'Todas las alertas',
		'filters.enrichedOnly': 'Solo enriquecidas',
		'filters.notEnriched': 'No enriquecidas',
		'filters.allSources': 'Todos los orígenes',
		'filters.before': 'Cursor anterior',
		'filters.beforeCursor': 'Cursor anterior',
		'filters.activeFilters': 'Filtros activos: {filters}',
		'filters.activeFiltersNone': 'Filtros activos: ninguno',
		'filters.searchDependencies': 'Buscar dependencias',
		'filters.filterByStatus': 'Filtrar por estado',
		'filters.allStatuses': 'Todos los estados',
		'filters.allWindows': 'Todas las ventanas',
		'filters.pending': 'Pendiente',
		'filters.evaluated': 'Evaluado',
		'filters.unavailable': 'No disponible',
		'filters.last24h': 'Últimas 24h',
		'filters.customRange': 'Rango personalizado',

		// Literal string aliases for direct t(literal) calls
		'No measurements found': 'No se encontraron mediciones',
		'No delivery channels reported.': 'No se reportaron canales de entrega.',
		'Checking authentication…': 'Comprobando autenticación…',
		'Firebase sign-in is unavailable': 'El inicio de sesión de Firebase no está disponible',
		'Firebase sign-in is unavailable. Ask an administrator to configure it.': 'El inicio de sesión de Firebase no está disponible. Pide a un administrador que lo configure.',
		'Status unavailable.': 'Estado no disponible.',
		'Status unavailable. Check the API key and service logs.': 'Estado no disponible. Revisa la clave API y los registros del servicio.',
		'No dependencies reported.': 'No se reportaron dependencias.',
		'No dependencies match these filters.': 'Ninguna dependencia coincide con estos filtros.',
		'No feature flags are enabled.': 'No hay banderas de características habilitadas.',
		'Enter an API key to load live status.': 'Ingresa una clave API para cargar el estado en vivo.',
		'No stored alerts match these filters.': 'Ninguna alerta almacenada coincide con estos filtros.',
		'No recorded outcomes match these filters.': 'Ningún resultado registrado coincide con estos filtros.',
		'No scanner presets found.': 'No se encontraron plantillas de escaneo.',
		'No alert subscribers found.': 'No se encontraron suscriptores de alertas.',
		'No recent jobs found.': 'No se encontraron tareas recientes.',
		'No recent orders found.': 'No se encontraron órdenes recientes.',
		'No open positions recorded.': 'No hay posiciones abiertas registradas.',
		'No order mutations recorded yet.': 'No se han registrado mutaciones de órdenes aún.',
		'No events yet — connect a key or sign in to stream.': 'Sin eventos aún — conecta una clave o inicia sesión para transmitir.',
		'Loading API contract…': 'Cargando contrato de API…',
		'Request in progress…': 'Solicitud en curso…',
		'Waiting for live status…': 'Esperando estado en vivo…',
		'Loading live status…': 'Cargando estado en vivo…',
		'No status response yet.': 'Sin respuesta de estado aún.',
		'Response details': 'Detalles de respuesta',
		'Sign in to continue.': 'Inicia sesión para continuar.',
		'Sign in required.': 'Inicio de sesión requerido.',
		'This account is not authorized for the admin console.': 'Esta cuenta no está autorizada para la consola de administración.',
		'Unable to verify the signed-in account.': 'No se pudo verificar la cuenta que inició sesión.',
		'Previous page': 'Página anterior',
		'Next page': 'Página siguiente',
		'Clear filters': 'Limpiar filtros',
		'Refresh dashboard': 'Actualizar panel',
		'Refresh report': 'Actualizar reporte',
		'Run self-test': 'Ejecutar autodiagnóstico',
		'Copy details': 'Copiar detalles',
		'Operational overview': 'Resumen operativo',
		'Limit': 'Límite',
		'Before cursor': 'Cursor anterior',
		'From': 'Desde',
		'To': 'Hasta',
		'Source': 'Origen',
		'Enriched': 'Enriquecida',
		'Symbol': 'Símbolo',
		'Exchange': 'Exchange',
		'Status': 'Estado',
		'Window': 'Ventana',
		'All alerts': 'Todas las alertas',
		'Enriched only': 'Solo enriquecidas',
		'Not enriched': 'No enriquecidas',
		'All sources': 'Todos los orígenes',
		'All statuses': 'Todos los estados',
		'All windows': 'Todas las ventanas',
		'Pending': 'Pendiente',
		'Evaluated': 'Evaluado',
		'Unavailable': 'No disponible',
		'Active filters: none': 'Filtros activos: ninguno',
		'Ready': 'Listo',
		'Disabled': 'Deshabilitado',
		'Degraded': 'Degradado',
		'Unconfigured': 'No configurado',
		'Needs attention': 'Requiere atención',
		'Unknown': 'Desconocido',
	};

	const locales = { en, es };
	let activeLocale = null;

	const normalizeLocale = (raw) => {
		if (!raw || typeof raw !== 'string') return null;
		const lower = raw.trim().toLowerCase();
		if (lower === 'es' || lower.startsWith('es-') || lower.startsWith('es_')) return 'es';
		if (lower === 'en' || lower.startsWith('en-') || lower.startsWith('en_')) return 'en';
		return null;
	};

	const resolveLocale = ({ search, localStorage } = {}) => {
		// 1. URL (?lang=...)
		try {
			let searchStr = '';
			if (typeof search === 'string') searchStr = search;
			else if (typeof window !== 'undefined' && window.location && window.location.search) {
				searchStr = window.location.search;
			}
			if (searchStr) {
				const params = new URLSearchParams(searchStr);
				const fromUrl = normalizeLocale(params.get('lang'));
				if (fromUrl) return fromUrl;
			}
		} catch (_) { /* ignore */ }

		// 2. localStorage
		try {
			const storage = localStorage !== undefined
				? localStorage
				: (typeof window !== 'undefined' ? window.localStorage : null);
			if (storage) {
				const val = typeof storage.getItem === 'function'
					? (storage.getItem('admin_lang') || storage.getItem('cabros-admin-lang'))
					: (storage.admin_lang || storage['cabros-admin-lang']);
				const fromStorage = normalizeLocale(val);
				if (fromStorage) return fromStorage;
			}
		} catch (_) { /* ignore */ }

		// 3. Default (strictly opt-in; en is default)
		return DEFAULT_LOCALE;
	};

	const getLocale = () => activeLocale || resolveLocale();

	const setLocale = (lang, { persist = true } = {}) => {
		const normalized = normalizeLocale(lang) || DEFAULT_LOCALE;
		activeLocale = normalized;

		if (persist) {
			try {
				if (typeof window !== 'undefined' && window.localStorage) {
					if (typeof window.localStorage.setItem === 'function') {
						window.localStorage.setItem('admin_lang', normalized);
					} else {
						window.localStorage.admin_lang = normalized;
					}
				}
			} catch (_) { /* storage write failure is non-blocking */ }
		}

		try {
			if (typeof document !== 'undefined' && document && document.documentElement) {
				document.documentElement.lang = normalized;
				document.documentElement.setAttribute('lang', normalized);
			}
		} catch (_) { /* document mutation is best-effort */ }

		return normalized;
	};

	const interpolate = (template, variables) => {
		if (typeof template !== 'string') return '';
		if (!variables || typeof variables !== 'object') return template;
		return template.replace(/\{(\w+)\}/g, (match, key) => (
			Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match
		));
	};

	const t = (key, options = {}) => {
		if (typeof key !== 'string') return '';
		const targetLang = options.lang || getLocale();
		const dict = locales[targetLang] || locales[DEFAULT_LOCALE];
		const fallbackDict = locales[DEFAULT_LOCALE];

		let text = dict[key];
		if (text === undefined) {
			text = fallbackDict[key];
		}
		if (text === undefined) {
			text = options.default !== undefined ? options.default : key;
		}

		return interpolate(text, options);
	};

	return {
		SUPPORTED_LOCALES,
		DEFAULT_LOCALE,
		locales,
		normalizeLocale,
		resolveLocale,
		getLocale,
		setLocale,
		t,
	};
}));
