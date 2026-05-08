const DEFAULT_LANGFUSE_BASE_URL = 'https://cloud.langfuse.com';

let clientPromise = null;

function getLangfuseSettings() {
	return {
		enabled: process.env.ENABLE_LANGFUSE_PROMPTS === 'true',
		publicKey: process.env.LANGFUSE_PUBLIC_KEY,
		secretKey: process.env.LANGFUSE_SECRET_KEY,
		baseUrl: process.env.LANGFUSE_BASE_URL || DEFAULT_LANGFUSE_BASE_URL,
	};
}

function isLangfuseConfigured() {
	const settings = getLangfuseSettings();
	return settings.enabled && Boolean(settings.publicKey) && Boolean(settings.secretKey);
}

function getLangfuseDisabledReason() {
	const settings = getLangfuseSettings();

	if (!settings.enabled) {
		return 'Langfuse prompt management is disabled';
	}

	if (!settings.publicKey || !settings.secretKey) {
		return 'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required when ENABLE_LANGFUSE_PROMPTS is true';
	}

	return null;
}

async function loadLangfuseClientConstructor() {
	const langfuseModule = await import('@langfuse/client');
	return langfuseModule.LangfuseClient
		|| langfuseModule.default?.LangfuseClient
		|| langfuseModule.default;
}

async function getLangfuseClient() {
	const disabledReason = getLangfuseDisabledReason();
	if (disabledReason) {
		throw new Error(disabledReason);
	}

	if (!clientPromise) {
		clientPromise = loadLangfuseClientConstructor().then(LangfuseClient => {
			if (!LangfuseClient) {
				throw new Error('LangfuseClient constructor could not be resolved from @langfuse/client');
			}

			const settings = getLangfuseSettings();
			return new LangfuseClient({
				publicKey: settings.publicKey,
				secretKey: settings.secretKey,
				baseUrl: settings.baseUrl,
			});
		});
	}

	return clientPromise;
}

function resetLangfuseClientForTests() {
	clientPromise = null;
}

module.exports = {
	DEFAULT_LANGFUSE_BASE_URL,
	getLangfuseClient,
	getLangfuseSettings,
	isLangfuseConfigured,
	getLangfuseDisabledReason,
	resetLangfuseClientForTests,
};