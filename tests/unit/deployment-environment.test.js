const {
	isPreviewEnvironment,
	isProductionLikeEnvironment,
	getDeploymentCommit,
	getDeploymentRepoSlug,
} = require('../../src/lib/deploymentEnvironment');

describe('deployment environment helpers', () => {
	it('recognizes Vercel preview deployments', () => {
		expect(isPreviewEnvironment({ VERCEL_ENV: 'preview' })).toBe(true);
	});

	it('does not classify Vercel production as preview', () => {
		expect(isPreviewEnvironment({ VERCEL_ENV: 'production' })).toBe(false);
		expect(isProductionLikeEnvironment({ VERCEL_ENV: 'production' })).toBe(true);
	});

	it('retains Render pull-request preview detection', () => {
		expect(isPreviewEnvironment({ RENDER: 'true', IS_PULL_REQUEST: 'true' })).toBe(true);
	});

	it('reads Vercel deployment metadata', () => {
		const env = {
			VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890',
			VERCEL_GIT_REPO_OWNER: 'francovp',
			VERCEL_GIT_REPO_SLUG: 'cabros-bot',
		};

		expect(getDeploymentCommit(env)).toBe('abcdef1234567890');
		expect(getDeploymentRepoSlug(env)).toBe('francovp/cabros-bot');
	});

	it('supports the legacy Vercel repository owner variable', () => {
		expect(getDeploymentRepoSlug({
			VERCEL_GIT_REPO_OWNER_NAME: 'francovp',
			VERCEL_GIT_REPO_SLUG: 'cabros-bot',
		})).toBe('francovp/cabros-bot');
	});
});
