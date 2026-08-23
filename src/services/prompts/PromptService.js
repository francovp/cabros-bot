const {
	isLangfusePromptManagementEnabled,
	getLangfusePromptLabel,
	getLangfusePromptCacheTtlSeconds,
} = require('./config');
const {
	getLangfuseClient,
	getLangfuseDisabledReason,
} = require('./langfuseClient');
const {
	PromptKeys,
	getPromptDefinition,
} = require('./promptRegistry');

const REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS = Object.freeze([
	'invalidation_level',
	'target_level',
	'setup_type',
	'risk_reward_ratio',
]);

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

	return {
		schemaDriftDetected: missingRiskFields.length > 0,
		missingRiskFields,
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
	}

	getSchemaDriftStatus() {
		const result = {};
		for (const [key, value] of this.schemaDriftStatus.entries()) {
			result[key] = { ...value };
		}
		return result;
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
				return remotePrompt;
			}
		}

		return this.resolveLocalPrompt(definition, variables, options);
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

		try {
			client = await this.clientProvider();
		} catch (error) {
			const disabledReason = usingDefaultClientProvider
				? getLangfuseDisabledReason() || error.message
				: error.message;
			this.warnOnce(
				`langfuse-disabled:${disabledReason}`,
				`[PromptService] Langfuse prompt management unavailable, using local fallbacks: ${disabledReason}`,
			);
			return null;
		}

		if (usingDefaultClientProvider) {
			const disabledReason = getLangfuseDisabledReason();
			if (disabledReason) {
				this.warnOnce(
					`langfuse-disabled:${disabledReason}`,
					`[PromptService] Langfuse prompt management unavailable, using local fallbacks: ${disabledReason}`,
				);
				return null;
			}
		}

		const label = options.label || getLangfusePromptLabel();
		const cacheTtlSeconds = options.cacheTtlSeconds ?? getLangfusePromptCacheTtlSeconds();

		try {
			const prompt = await fetchPromptFromClient(client, definition.name, {
				type: definition.type,
				label,
				cacheTtlSeconds,
			});
			this.logger.debug?.(`[PromptService] Fetched Langfuse prompt "${definition.name}" successfully`);

			const compiledPrompt = prompt.compile(variables);
			const rawContent = prompt.prompt || prompt.messages || compiledPrompt;
			const riskSchemaCheck = inspectAlertEnrichmentRiskSchema(definition.name, rawContent);

			if (riskSchemaCheck.schemaDriftDetected) {
				const driftKey = `${definition.name}:${prompt.version ?? 'unknown'}`;
				this.schemaDriftStatus.set(driftKey, {
					promptName: definition.name,
					version: prompt.version ?? null,
					label,
					missingRiskFields: riskSchemaCheck.missingRiskFields,
					detectedAt: new Date().toISOString(),
				});
				this.warnOnce(
					`schema-drift:${driftKey}`,
					`[PromptService] Langfuse prompt "${definition.name}" (version ${prompt.version}) missing required risk fields: ${riskSchemaCheck.missingRiskFields.join(', ')}. Downstream risk coverage may be degraded.`,
				);
			}

			const metadata = {
				name: definition.name,
				source: 'langfuse',
				label,
				version: prompt.version,
				schemaDriftDetected: riskSchemaCheck.schemaDriftDetected,
				missingRiskFields: riskSchemaCheck.missingRiskFields,
			};

			if (definition.type === 'chat') {
				return this.normalizeChatPrompt(compiledPrompt, metadata);
			}

			return {
				type: 'text',
				text: normalizeMessageContent(compiledPrompt),
				...metadata,
			};
		} catch (error) {
			this.warnOnce(
				`langfuse-fetch:${definition.name}:${error.message}`,
				`[PromptService] Failed to fetch Langfuse prompt "${definition.name}", using local fallback: ${error.message}`,
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
	inspectAlertEnrichmentRiskSchema,
	PromptKeys,
	PromptService,
	getPromptService,
	resetPromptServiceForTests,
};