function isProductionLikeEnvironment() {
	return process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
}

function isLangfusePromptManagementEnabled() {
	return process.env.ENABLE_LANGFUSE_PROMPTS === 'true';
}

function getLangfusePromptLabel() {
	if (process.env.LANGFUSE_PROMPT_LABEL) {
		return process.env.LANGFUSE_PROMPT_LABEL;
	}

	return isProductionLikeEnvironment() ? 'production' : 'latest';
}

function getLangfusePromptCacheTtlSeconds() {
	if (process.env.LANGFUSE_PROMPT_CACHE_TTL_SECONDS !== undefined) {
		const parsed = Number.parseInt(process.env.LANGFUSE_PROMPT_CACHE_TTL_SECONDS, 10);
		return Number.isNaN(parsed) ? 0 : parsed;
	}

	return getLangfusePromptLabel() === 'latest' ? 0 : 60;
}

module.exports = {
	isProductionLikeEnvironment,
	isLangfusePromptManagementEnabled,
	getLangfusePromptLabel,
	getLangfusePromptCacheTtlSeconds,
};