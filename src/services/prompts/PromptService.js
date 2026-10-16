const {
	isLangfusePromptManagementEnabled,
	getLangfusePromptLabel,
	getLangfusePromptCacheTtlSeconds,
} = require('./config');
const {
	getLangfuseClient,
	getLangfuseDisabledReason,
	isLangfuseConfigured,
} = require('./langfuseClient');
const {
	PromptKeys,
	PROMPT_DEFINITIONS,
	getPromptDefinition,
} = require('./promptRegistry');
const {
	classifyPromptError,
	getPromptReadiness,
	recordPromptReadinessSafely,
} = require('./promptReadiness');

const REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS = Object.freeze([
	'invalidation_level',
	'target_level',
	'setup_type',
	'setup_evidence',
	'risk_reward_ratio',
]);
/**
 * Markers the `alert-enrichment` prompt must carry to be considered calibrated.
 *
 * These replaced the older `0.9+ / 0.6-0.8 / corroborating sources` triple. That
 * rubric had no reference anchor and no justification field, which is how
 * production ended up with 87.6% of scores at or above 0.75 (issue #1031). The
 * anchors are now absolute band values and the model must name its choice, so
 * the markers are the band values plus the required field.
 *
 * It also requires the market-structure setup type rubric and omission guidance
 * (issue #1254) so uncorroborated classifications lacking setup evidence are
 * omitted rather than hallucinated.
 *
 * The local fallback is inspected by the same function, so the two stay in
 * lockstep: a Langfuse prompt that has not been republished reports
 * `schemaDriftDetected` until it carries the anchors, the justification
 * field, and the setup rubric markers. That flag is the intended rollout signal, not a failure.
 *
 * Optional price fields stay outside drift detection for legacy prompts (GH-599).
 */
const REQUIRED_ALERT_ENRICHMENT_CALIBRATION_GUIDANCE = Object.freeze([
	'sentiment_score_evidence',
	'0.90',
	'0.60',
	'0.30',
	'Setup type rubric',
	'OMIT `setup_type` and `setup_evidence` entirely',
]);

/**
 * Closed enum of prompt-fetch error categories exposed on /api/status.
 * Raw provider error messages are deliberately never surfaced: they can embed
 * request context or credential fragments, and the operational question an
 * operator needs answered is "which failure mode", not "what did it say".
 */
const PROMPT_FETCH_ERROR_CATEGORIES = Object.freeze({
	CLIENT_UNAVAILABLE: 'client_unavailable',
	PROMPT_NOT_FOUND: 'prompt_not_found',
	UNAUTHORIZED: 'unauthorized',
	RATE_LIMITED: 'rate_limited',
	TIMEOUT: 'timeout',
	COMPILE_FAILED: 'compile_failed',
	REQUEST_FAILED: 'request_failed',
	UNKNOWN: 'unknown',
});

function classifyPromptFetchError(error) {
	const message = (error?.message || '').toLowerCase();

	if (!message) {
		return PROMPT_FETCH_ERROR_CATEGORIES.UNKNOWN;
	}
	if (message.startsWith(`${PROMPT_FETCH_ERROR_CATEGORIES.CLIENT_UNAVAILABLE}:`)) {
		return PROMPT_FETCH_ERROR_CATEGORIES.CLIENT_UNAVAILABLE;
	}
	if (message.includes('prompt not found') || message.includes('langfusepromptnotfounderror') || message.includes('prompt_not_found')) {
		return PROMPT_FETCH_ERROR_CATEGORIES.PROMPT_NOT_FOUND;
	}
	if (message.includes('401') || message.includes('unauthorized') || message.includes('403') || message.includes('forbidden')) {
		return PROMPT_FETCH_ERROR_CATEGORIES.UNAUTHORIZED;
	}
	if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests') || message.includes('resource_exhausted')) {
		return PROMPT_FETCH_ERROR_CATEGORIES.RATE_LIMITED;
	}
	if (message.includes('timeout') || message.includes('timed out') || message.includes('etimedout') || message.includes('aborted')) {
		return PROMPT_FETCH_ERROR_CATEGORIES.TIMEOUT;
	}
	if (message.includes('compile') || message.includes('template')) {
		return PROMPT_FETCH_ERROR_CATEGORIES.COMPILE_FAILED;
	}
	if (
		message.includes('econnrefused')
		|| message.includes('econnreset')
		|| message.includes('enotfound')
		|| message.includes('fetch failed')
		|| message.includes('socket hang up')
		|| message.includes('connection reset')
		|| message.includes('connection closed')
		|| message.includes('network')
		|| message.includes('eai_again')
	) {
		return PROMPT_FETCH_ERROR_CATEGORIES.REQUEST_FAILED;
	}

	return PROMPT_FETCH_ERROR_CATEGORIES.UNKNOWN;
}

function roundPercent(numerator, denominator) {
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
		return null;
	}

	return Math.round((numerator / denominator) * 1000) / 10;
}

function createEmptyTelemetry() {
	return {
		totalResolutions: 0,
		langfuseResolutions: 0,
		localResolutions: 0,
		remoteFetchAttempts: 0,
		remoteFetchSuccesses: 0,
		remoteFetchFailures: 0,
		lastSuccessfulFetchAt: null,
		lastFailedFetchAt: null,
		lastErrorCategory: null,
		consecutiveFailures: 0,
		prompts: new Map(),
	};
}

function inspectAlertEnrichmentRiskSchema(promptName, content) {
	if (promptName !== 'alert-enrichment' && promptName !== PromptKeys.ALERT_ENRICHMENT) {
		return { schemaDriftDetected: false, missingRiskFields: [] };
	}

	let textToScan = '';
	if (typeof content === 'string') {
		textToScan = content;
	} else if (Array.isArray(content)) {
		textToScan = content
			.map(msg => (typeof msg === 'string' ? msg : msg?.content || msg?.text || ''))
			.join('\n');
	} else if (content && typeof content === 'object') {
		textToScan = content.text || content.content || JSON.stringify(content);
	}

	const missingRiskFields = REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS.filter(
		field => !textToScan.includes(field),
	);
	const missingCalibrationGuidance = REQUIRED_ALERT_ENRICHMENT_CALIBRATION_GUIDANCE.filter(
		marker => !textToScan.includes(marker),
	);

	return {
		schemaDriftDetected: missingRiskFields.length > 0 || missingCalibrationGuidance.length > 0,
		missingRiskFields,
		missingCalibrationGuidance,
	};
}

function normalizeMessageContent(content) {
	if (typeof content === 'string') {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.map(part => normalizeMessageContent(part))
			.filter(Boolean)
			.join('');
	}

	if (content && typeof content === 'object') {
		if (typeof content.text === 'string') {
			return content.text;
		}

		if (typeof content.content === 'string') {
			return content.content;
		}
	}

	return '';
}

function normalizeChatMessages(messages = []) {
	return messages
		.map(message => ({
			role: message.role,
			content: normalizeMessageContent(message.content),
		}))
		.filter(message => Boolean(message.role) && Boolean(message.content));
}

function collapseUserPrompt(messages = []) {
	return messages
		.filter(message => message.role !== 'system')
		.map(message => message.role === 'user' ? message.content : `[${message.role}] ${message.content}`)
		.join('\n\n')
		.trim();
}

async function fetchPromptFromClient(client, promptName, options) {
	if (client?.prompt?.get) {
		return client.prompt.get(promptName, options);
	}

	if (typeof client?.getPrompt === 'function') {
		return client.getPrompt(promptName, undefined, options);
	}

	throw new Error('Langfuse client does not support prompt.get or getPrompt');
}

class PromptService {
	constructor({ clientProvider = getLangfuseClient, logger = console } = {}) {
		this.clientProvider = clientProvider;
		this.logger = logger;
		this.warningCache = new Set();
		this.schemaDriftStatus = new Map();
		this.telemetry = createEmptyTelemetry();
	}

	getSchemaDriftStatus() {
		const result = {};
		for (const [key, value] of this.schemaDriftStatus.entries()) {
			result[key] = { ...value };
		}
		return result;
	}

	/**
	 * Non-secret prompt-resolution telemetry.
	 *
	 * "Langfuse is configured and reachable" (dependencies.langfuse) and
	 * "prompts are actually being served from Langfuse" (this) are different
	 * facts. Without the second one, a 100%-local-fallback regression is
	 * invisible: readiness stays green while every published prompt change is
	 * silently ignored. Everything returned here is counts, tiers, timestamps
	 * and a closed error-category enum — never prompt content or key material.
	 */
	getPromptResolutionStatus() {
		const telemetry = this.telemetry || createEmptyTelemetry();
		const enabled = isLangfusePromptManagementEnabled();
		const configured = isLangfuseConfigured();

		let servingStatus;
		if (!enabled) {
			servingStatus = 'disabled';
		} else if (!configured) {
			servingStatus = 'unconfigured';
		} else if (telemetry.totalResolutions === 0) {
			// Configured and reachable, but nothing has been resolved yet, so
			// serving is genuinely unknown rather than healthy.
			servingStatus = 'no_traffic';
		} else if (telemetry.langfuseResolutions === 0) {
			// Every remote fetch failed: Langfuse answers, but serves no prompt.
			servingStatus = 'local_fallback';
		} else if (telemetry.consecutiveFailures > 0) {
			// Latch on CONSECUTIVE failures, not on the cumulative local count.
			// `localResolutions > 0` is monotonic for the life of the process, so one
			// boot-time probe of a single misconfigured prompt pinned a healthy
			// deployment to `degraded` forever with no real alert traffic - the exact
			// latch master's promptReadiness deliberately avoids.
			servingStatus = 'degraded';
		} else {
			servingStatus = 'serving';
		}

		return {
			enabled,
			configured,
			// The OBSERVED serving verdict, not credential shape. This previously read
			// `enabled && configured`, which contradicted its own comment and reported
			// `ready: true` on a deployment whose servingStatus was `local_fallback` -
			// a green light on exactly the regression this block exists to expose.
			// dependencies.langfuse.ready remains the configuration fact.
			ready: servingStatus === 'serving',
			servingStatus,
			servingPrompts: telemetry.langfuseResolutions > 0,
			label: enabled ? getLangfusePromptLabel() : null,
			cacheTtlSeconds: enabled ? getLangfusePromptCacheTtlSeconds() : null,
			totalResolutions: telemetry.totalResolutions,
			langfuseResolutions: telemetry.langfuseResolutions,
			localResolutions: telemetry.localResolutions,
			localResolutionRatePercent: roundPercent(
				telemetry.localResolutions,
				telemetry.totalResolutions,
			),
			remoteFetchAttempts: telemetry.remoteFetchAttempts,
			remoteFetchSuccesses: telemetry.remoteFetchSuccesses,
			remoteFetchFailures: telemetry.remoteFetchFailures,
			remoteFetchSuccessRatePercent: roundPercent(
				telemetry.remoteFetchSuccesses,
				telemetry.remoteFetchAttempts,
			),
			lastSuccessfulFetchAt: telemetry.lastSuccessfulFetchAt,
			lastFailedFetchAt: telemetry.lastFailedFetchAt,
			lastErrorCategory: telemetry.lastErrorCategory,
			consecutiveFailures: telemetry.consecutiveFailures,
			prompts: [...telemetry.prompts.values()].map((entry) => ({ ...entry })),
		};
	}

	resetTelemetryForTesting() {
		this.telemetry = createEmptyTelemetry();
	}

	_getPromptTelemetry(promptName, type) {
		if (!this.telemetry) {
			this.telemetry = createEmptyTelemetry();
		}

		let entry = this.telemetry.prompts.get(promptName);
		if (!entry) {
			entry = {
				name: promptName,
				type,
				langfuseResolutions: 0,
				localResolutions: 0,
				lastSource: null,
				lastLangfuseVersion: null,
				lastResolvedAt: null,
			};
			this.telemetry.prompts.set(promptName, entry);
		}

		entry.type = type;
		return entry;
	}

	/**
	 * Fail-open by contract: telemetry must never be able to break prompt
	 * resolution, because prompt resolution feeds live alert delivery.
	 */
	_recordResolution(promptName, type, source, { version = null } = {}) {
		try {
			if (!this.telemetry) {
				return;
			}

			this.telemetry.totalResolutions += 1;
			const entry = this._getPromptTelemetry(promptName, type);
			entry.lastSource = source;
			entry.lastResolvedAt = new Date().toISOString();

			if (source === 'langfuse') {
				this.telemetry.langfuseResolutions += 1;
				entry.langfuseResolutions += 1;
				entry.lastLangfuseVersion = version ?? null;
			} else {
				this.telemetry.localResolutions += 1;
				entry.localResolutions += 1;
			}
		} catch (error) {
			this.logger.warn?.(`[PromptService] Failed to record prompt-resolution telemetry: ${error.message}`);
		}
	}

	_recordFetchAttempt() {
		try {
			if (!this.telemetry) {
				return;
			}
			this.telemetry.remoteFetchAttempts += 1;
		} catch (error) {
			this.logger.warn?.(`[PromptService] Failed to record prompt-fetch attempt: ${error.message}`);
		}
	}

	_recordFetchSuccess() {
		try {
			if (!this.telemetry) {
				return;
			}
			this.telemetry.remoteFetchSuccesses += 1;
			this.telemetry.consecutiveFailures = 0;
			this.telemetry.lastSuccessfulFetchAt = new Date().toISOString();
		} catch (error) {
			this.logger.warn?.(`[PromptService] Failed to record prompt-fetch success: ${error.message}`);
		}
	}

	_recordFetchFailure(error) {
		try {
			if (!this.telemetry) {
				return;
			}
			this.telemetry.remoteFetchFailures += 1;
			this.telemetry.consecutiveFailures += 1;
			this.telemetry.lastFailedFetchAt = new Date().toISOString();
			this.telemetry.lastErrorCategory = classifyPromptFetchError(error);
		} catch (recordingError) {
			this.logger.warn?.(`[PromptService] Failed to record prompt-fetch failure: ${recordingError.message}`);
		}
	}

	warnOnce(cacheKey, message) {
		if (this.warningCache.has(cacheKey)) {
			return;
		}

		this.warningCache.add(cacheKey);
		this.logger.warn(message);
	}

	async resolvePrompt(promptKey, variables = {}, options = {}) {
		const definition = getPromptDefinition(promptKey);

		if (isLangfusePromptManagementEnabled()) {
			const remotePrompt = await this.resolveRemotePrompt(definition, variables, options);
			if (remotePrompt) {
				this._recordResolutionFailOpen(definition.name, definition.type, 'langfuse', {
					version: remotePrompt.version ?? null,
				});
				return remotePrompt;
			}

			recordPromptReadinessSafely(
				() => getPromptReadiness().recordLocalFallback({ promptName: definition.name }),
			);
		}

		const localPrompt = this.resolveLocalPrompt(definition, variables, options);
		this._recordResolutionFailOpen(definition.name, definition.type, 'local');
		return localPrompt;
	}

	/**
	 * Telemetry is observability, never a delivery dependency. The recorder
	 * already swallows its own errors; this wrapper additionally guarantees the
	 * resolved prompt is returned even if the recorder itself is broken or has
	 * been tampered with, so a telemetry defect can never fail a live alert.
	 */
	_recordResolutionFailOpen(promptName, type, source, metadata) {
		try {
			this._recordResolution(promptName, type, source, metadata);
		} catch (error) {
			this.logger.warn?.(`[PromptService] Prompt-resolution telemetry unavailable: ${error.message}`);
		}
	}

	async getChatPrompt(promptKey, variables = {}, options = {}) {
		const prompt = await this.resolvePrompt(promptKey, variables, options);
		if (prompt.type !== 'chat') {
			throw new Error(`Prompt ${promptKey} is not a chat prompt`);
		}

		const systemPrompt = options.systemPromptOverride || prompt.systemPrompt;
		const userPrompt = options.userPromptOverride || prompt.userPrompt;

		return {
			...prompt,
			systemPrompt,
			userPrompt,
		};
	}

	async getTextPrompt(promptKey, variables = {}, options = {}) {
		const prompt = await this.resolvePrompt(promptKey, variables, options);
		if (prompt.type !== 'text') {
			throw new Error(`Prompt ${promptKey} is not a text prompt`);
		}

		return prompt;
	}

	async resolveRemotePrompt(definition, variables = {}, options = {}) {
		let client;
		const usingDefaultClientProvider = this.clientProvider === getLangfuseClient;

		// Asking for a remote prompt and not getting one is the event an operator
		// needs to see, so this counts even when client initialization is refused.
		recordPromptReadinessSafely(() => getPromptReadiness().recordAttempt());

		try {
			client = await this.clientProvider();
		} catch (error) {
			const disabledReason = usingDefaultClientProvider
				? getLangfuseDisabledReason() || error.message
				: error.message;
			// Reaching the provider at all is a fetch attempt; not being able to
			// is a fetch failure, so `local_fallback` also covers credential and
			// client-construction outages rather than fetch errors alone. Only a
			// provider we could not construct is `client_unavailable`; any other
			// rejection is classified on its own merits (network, auth, ...).
			this._recordFetchAttempt();
			this._recordFetchFailure(
				usingDefaultClientProvider
					? new Error(`${PROMPT_FETCH_ERROR_CATEGORIES.CLIENT_UNAVAILABLE}: ${disabledReason}`)
					: error,
			);
			this.warnOnce(
				`langfuse-disabled:${disabledReason}`,
				`[PromptService] Langfuse prompt management unavailable, using local fallbacks: ${disabledReason}`,
			);
			recordPromptReadinessSafely(
				() => getPromptReadiness().recordFailure(classifyPromptError(error)),
			);
			return null;
		}

		if (usingDefaultClientProvider) {
			const disabledReason = getLangfuseDisabledReason();
			if (disabledReason) {
				this._recordFetchAttempt();
				this._recordFetchFailure(new Error(`${PROMPT_FETCH_ERROR_CATEGORIES.CLIENT_UNAVAILABLE}: ${disabledReason}`));
				this.warnOnce(
					`langfuse-disabled:${disabledReason}`,
					`[PromptService] Langfuse prompt management unavailable, using local fallbacks: ${disabledReason}`,
				);
				recordPromptReadinessSafely(
					() => getPromptReadiness().recordFailure(classifyPromptError(disabledReason)),
				);
				return null;
			}
		}

		const label = options.label || getLangfusePromptLabel();
		const cacheTtlSeconds = options.cacheTtlSeconds ?? getLangfusePromptCacheTtlSeconds();

		try {
			this._recordFetchAttempt();
			const prompt = await fetchPromptFromClient(client, definition.name, {
				type: definition.type,
				label,
				cacheTtlSeconds,
			});
			this.logger.debug?.(`[PromptService] Fetched Langfuse prompt "${definition.name}" successfully`);

			// Compile BEFORE recording success: compile() sits inside this same try, so a
			// compile failure reaches the catch below and records a failure. Recording
			// success first counted one attempt as both a success and a failure, so
			// attempts !== successes + failures and a resolution that fell back to the
			// local file still reported remoteFetchSuccessRatePercent: 100.
			const compiledPrompt = prompt.compile(variables);
			this._recordFetchSuccess();
			const rawContent = prompt.prompt || prompt.messages || compiledPrompt;
			const riskSchemaCheck = inspectAlertEnrichmentRiskSchema(definition.name, rawContent);

			if (riskSchemaCheck.schemaDriftDetected) {
				const driftKey = `${definition.name}:${prompt.version ?? 'unknown'}`;
				this.schemaDriftStatus.set(driftKey, {
					promptName: definition.name,
					version: prompt.version ?? null,
					label,
					missingRiskFields: riskSchemaCheck.missingRiskFields,
					missingCalibrationGuidance: riskSchemaCheck.missingCalibrationGuidance,
					detectedAt: new Date().toISOString(),
				});
				this.warnOnce(
					`schema-drift:${driftKey}`,
					`[PromptService] Langfuse prompt "${definition.name}" (version ${prompt.version}) missing required risk fields: ${riskSchemaCheck.missingRiskFields.join(', ') || 'none'}; missing calibration guidance: ${riskSchemaCheck.missingCalibrationGuidance.join(', ') || 'none'}. Downstream risk coverage may be degraded.`,
				);
			}

			const metadata = {
				name: definition.name,
				source: 'langfuse',
				label,
				version: prompt.version,
				schemaDriftDetected: riskSchemaCheck.schemaDriftDetected,
				missingRiskFields: riskSchemaCheck.missingRiskFields,
				missingCalibrationGuidance: riskSchemaCheck.missingCalibrationGuidance,
			};

			if (definition.type === 'chat') {
				recordPromptReadinessSafely(() => getPromptReadiness().recordSuccess({
					promptName: definition.name,
					label,
					version: prompt.version,
				}));
				return this.normalizeChatPrompt(compiledPrompt, metadata);
			}

			recordPromptReadinessSafely(() => getPromptReadiness().recordSuccess({
				promptName: definition.name,
				label,
				version: prompt.version,
			}));
			return {
				type: 'text',
				text: normalizeMessageContent(compiledPrompt),
				...metadata,
			};
		} catch (error) {
			this._recordFetchFailure(error);
			this.warnOnce(
				`langfuse-fetch:${definition.name}:${error.message}`,
				`[PromptService] Failed to fetch Langfuse prompt "${definition.name}", using local fallback: ${error.message}`,
			);
			recordPromptReadinessSafely(
				() => getPromptReadiness().recordFailure(classifyPromptError(error)),
			);
			return null;
		}
	}

	resolveLocalPrompt(definition, variables = {}, options = {}) {
		const fallbackPrompt = definition.buildFallback(variables, options);
		const riskSchemaCheck = inspectAlertEnrichmentRiskSchema(
			definition.name,
			definition.type === 'chat' ? fallbackPrompt.messages : fallbackPrompt.text,
		);

		const metadata = {
			name: definition.name,
			source: 'local',
			label: null,
			version: null,
			schemaDriftDetected: riskSchemaCheck.schemaDriftDetected,
			missingRiskFields: riskSchemaCheck.missingRiskFields,
			missingCalibrationGuidance: riskSchemaCheck.missingCalibrationGuidance,
		};

		if (definition.type === 'chat') {
			return this.normalizeChatPrompt(fallbackPrompt.messages, metadata);
		}

		return {
			type: 'text',
			text: fallbackPrompt.text,
			...metadata,
		};
	}

	normalizeChatPrompt(messages, metadata) {
		const normalizedMessages = normalizeChatMessages(messages);
		if (!normalizedMessages.length) {
			throw new Error(`Prompt "${metadata.name}" resolved to an empty chat prompt`);
		}

		const systemPrompt = normalizedMessages
			.filter(message => message.role === 'system')
			.map(message => message.content)
			.join('\n\n')
			.trim();

		const userPrompt = collapseUserPrompt(normalizedMessages);
		if (!userPrompt) {
			throw new Error(`Prompt "${metadata.name}" resolved without user content`);
		}

		return {
			type: 'chat',
			messages: normalizedMessages,
			systemPrompt,
			userPrompt,
			...metadata,
		};
	}
}

let promptServiceInstance = null;

function getPromptService() {
	if (!promptServiceInstance) {
		promptServiceInstance = new PromptService();
	}

	return promptServiceInstance;
}

function resetPromptServiceForTests() {
	promptServiceInstance = null;
}

module.exports = {
	REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS,
	REQUIRED_ALERT_ENRICHMENT_CALIBRATION_GUIDANCE,
	inspectAlertEnrichmentRiskSchema,
	PromptKeys,
	PROMPT_DEFINITIONS,
	PromptService,
	getPromptService,
	resetPromptServiceForTests,
};
