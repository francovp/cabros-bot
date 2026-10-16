function isRailwayPreviewEnvironment(env) {
	return Boolean(env.RAILWAY_GIT_PULL_REQUEST_NUMBER)
		|| /(?:^|[-_ ])pr(?:[-_ ]|$)/i.test(env.RAILWAY_ENVIRONMENT_NAME || '');
}

function isPreviewEnvironment(env = process.env) {
	return env.VERCEL_ENV === 'preview'
		|| (env.RENDER === 'true' && env.IS_PULL_REQUEST === 'true')
		|| isRailwayPreviewEnvironment(env);
}

function isProductionLikeEnvironment(env = process.env) {
	return env.NODE_ENV === 'production'
		|| env.RENDER === 'true'
		|| env.VERCEL_ENV === 'production'
		|| Boolean(env.RAILWAY_ENVIRONMENT_NAME);
}

function getDeploymentCommit(env = process.env) {
	return env.RENDER_GIT_COMMIT
		|| env.VERCEL_GIT_COMMIT_SHA
		|| env.RAILWAY_GIT_COMMIT_SHA
		|| env.GIT_COMMIT
		|| env.COMMIT_SHA
		|| env.GITHUB_SHA
		|| env.SOURCE_VERSION
		|| null;
}

function getDeploymentRepoSlug(env = process.env) {
	if (env.RENDER_GIT_REPO_SLUG) return env.RENDER_GIT_REPO_SLUG;

	const vercelRepoSlug = env.VERCEL_GIT_REPO_SLUG;
	const vercelRepoOwner = env.VERCEL_GIT_REPO_OWNER || env.VERCEL_GIT_REPO_OWNER_NAME;
	if (vercelRepoSlug && vercelRepoOwner) return `${vercelRepoOwner}/${vercelRepoSlug}`;

	const railwayRepoName = env.RAILWAY_GIT_REPO_NAME;
	const railwayRepoOwner = env.RAILWAY_GIT_REPO_OWNER;
	if (railwayRepoName && railwayRepoOwner) return `${railwayRepoOwner}/${railwayRepoName}`;

	return vercelRepoSlug || railwayRepoName || 'cabros-bot';
}

let packageJsonMetadata = null;
try {
	packageJsonMetadata = require('../../package.json');
} catch {
	packageJsonMetadata = null;
}

let cachedLocalGitSha = undefined;

function _resetLocalGitShaCache() {
	cachedLocalGitSha = undefined;
}

function getLocalGitSha() {
	if (cachedLocalGitSha !== undefined) {
		return cachedLocalGitSha;
	}
	try {
		const { execSync } = require('child_process');
		const sha = execSync('git rev-parse HEAD', {
			timeout: 1000,
			stdio: ['ignore', 'pipe', 'ignore'],
			encoding: 'utf8',
		}).trim();
		cachedLocalGitSha = sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
	} catch {
		cachedLocalGitSha = null;
	}
	return cachedLocalGitSha;
}

function getDeploymentPlatform(env = process.env) {
	if (!env || typeof env !== 'object') {
		return null;
	}
	if (env.RENDER === 'true' || env.RENDER_SERVICE_ID || env.RENDER_SERVICE_NAME) {
		return 'render';
	}
	if (env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_SERVICE_ID || env.RAILWAY_GIT_COMMIT_SHA) {
		return 'railway';
	}
	if (env.VERCEL === '1' || env.VERCEL_ENV) {
		return 'vercel';
	}
	if (env.NODE_ENV === 'test') {
		return 'test';
	}
	if (env === process.env || env.NODE_ENV || env.PORT) {
		return 'local';
	}
	return null;
}

function getDeploymentService(env = process.env) {
	if (!env || typeof env !== 'object') {
		return (packageJsonMetadata && packageJsonMetadata.name) || 'cabros-bot';
	}
	const service = env.SERVICE_NAME
		|| env.RENDER_SERVICE_NAME
		|| env.RAILWAY_SERVICE_NAME
		|| (packageJsonMetadata && packageJsonMetadata.name)
		|| 'cabros-bot';
	return typeof service === 'string' && service.trim() ? service.trim() : 'cabros-bot';
}

function getRuntimeVersion() {
	return (packageJsonMetadata && typeof packageJsonMetadata.version === 'string')
		? packageJsonMetadata.version
		: null;
}

function getDeploymentIdentity(env = process.env) {
	try {
		const targetEnv = (env && typeof env === 'object') ? env : process.env;
		const platform = getDeploymentPlatform(targetEnv);
		let gitSha = getDeploymentCommit(targetEnv);
		if (!gitSha && (targetEnv === process.env || targetEnv.RESOLVE_LOCAL_GIT_SHA === 'true')) {
			gitSha = getLocalGitSha();
		}
		const service = getDeploymentService(targetEnv);
		const runtimeVersion = getRuntimeVersion(targetEnv);

		return {
			platform: platform || null,
			gitSha: gitSha || null,
			service: service || null,
			runtimeVersion: runtimeVersion || null,
		};
	} catch {
		return {
			platform: null,
			gitSha: null,
			service: 'cabros-bot',
			runtimeVersion: null,
		};
	}
}

module.exports = {
	getDeploymentCommit,
	getDeploymentRepoSlug,
	getDeploymentPlatform,
	getDeploymentService,
	getRuntimeVersion,
	getDeploymentIdentity,
	deploymentIdentity: getDeploymentIdentity,
	isPreviewEnvironment,
	isProductionLikeEnvironment,
	_resetLocalGitShaCache,
};
