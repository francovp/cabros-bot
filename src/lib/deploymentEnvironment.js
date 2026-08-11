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
	return env.RENDER_GIT_REPO_SLUG || env.VERCEL_GIT_REPO_SLUG || 'cabros-bot';
}

module.exports = {
	getDeploymentCommit,
	getDeploymentRepoSlug,
	isPreviewEnvironment,
	isProductionLikeEnvironment,
};
