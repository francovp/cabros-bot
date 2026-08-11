function isRailwayPreviewEnvironment(env) {
	return /^pr(?:[-_ ]|$)/i.test(env.RAILWAY_ENVIRONMENT_NAME || '');
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

module.exports = {
	getDeploymentCommit,
	getDeploymentRepoSlug,
	isPreviewEnvironment,
	isProductionLikeEnvironment,
};
