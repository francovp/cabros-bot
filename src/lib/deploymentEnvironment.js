function isPreviewEnvironment(env = process.env) {
	return env.VERCEL_ENV === 'preview'
		|| (env.RENDER === 'true' && env.IS_PULL_REQUEST === 'true');
}

function isProductionLikeEnvironment(env = process.env) {
	return env.NODE_ENV === 'production'
		|| env.RENDER === 'true'
		|| env.VERCEL_ENV === 'production';
}

function getDeploymentCommit(env = process.env) {
	return env.RENDER_GIT_COMMIT
		|| env.VERCEL_GIT_COMMIT_SHA
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

	return vercelRepoSlug || 'cabros-bot';
}

module.exports = {
	getDeploymentCommit,
	getDeploymentRepoSlug,
	isPreviewEnvironment,
	isProductionLikeEnvironment,
};
