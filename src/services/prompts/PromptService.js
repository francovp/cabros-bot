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

		try {
			client = await this.clientProvider();
		} catch (error) {
			const disabledReason = getLangfuseDisabledReason() || error.message;
			this.warnOnce(
				`langfuse-disabled:${disabledReason}`,
				`[PromptService] Langfuse prompt management unavailable, using local fallbacks: ${disabledReason}`,
			);
			return null;
		}

		const label = options.label || getLangfusePromptLabel();
		const cacheTtlSeconds = options.cacheTtlSeconds ?? getLangfusePromptCacheTtlSeconds();

		try {
			const prompt = await fetchPromptFromClient(client, definition.name, {
				type: definition.type,
				label,
				cacheTtlSeconds,
			});
			this.logger.debug(`[PromptService] Fetched Langfuse prompt "${definition.name}" successfully`);

			const compiledPrompt = prompt.compile(variables);
			if (definition.type === 'chat') {
				return this.normalizeChatPrompt(compiledPrompt, {
					name: definition.name,
					source: 'langfuse',
					label,
					version: prompt.version,
				});
			}

			return {
				type: 'text',
				text: normalizeMessageContent(compiledPrompt),
				name: definition.name,
				source: 'langfuse',
				label,
				version: prompt.version,
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
		if (definition.type === 'chat') {
			return this.normalizeChatPrompt(fallbackPrompt.messages, {
				name: definition.name,
				source: 'local',
				label: null,
				version: null,
			});
		}

		return {
			type: 'text',
			text: fallbackPrompt.text,
			name: definition.name,
			source: 'local',
			label: null,
			version: null,
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
	PromptKeys,
	PromptService,
	getPromptService,
	resetPromptServiceForTests,
};