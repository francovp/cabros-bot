const { isProductionLikeEnvironment: isManagedProductionEnvironment } = require('../../lib/deploymentEnvironment');
const { getRemoteOverride } = require('../remoteConfig/RemoteConfigService');

function isProductionLikeEnvironment() {
	return isManagedProductionEnvironment();
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

function shouldFallbackOnPromptDrift() {
	const remote = getRemoteOverride('PROMPT_FALLBACK_ON_DRIFT');
	return remote === undefined ? process.env.PROMPT_FALLBACK_ON_DRIFT === 'true' : remote === true;
}

module.exports = {
	isProductionLikeEnvironment,
	isLangfusePromptManagementEnabled,
	getLangfusePromptLabel,
	getLangfusePromptCacheTtlSeconds,
	shouldFallbackOnPromptDrift,
};
