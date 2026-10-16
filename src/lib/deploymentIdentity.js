'use strict';

const {
	getDeploymentCommit,
	getDeploymentRepoSlug,
	getDeploymentPlatform,
	getDeploymentService,
	getRuntimeVersion,
	getDeploymentIdentity,
	deploymentIdentity,
	isPreviewEnvironment,
	isProductionLikeEnvironment,
	_resetLocalGitShaCache,
} = require('./deploymentEnvironment');

module.exports = {
	getDeploymentCommit,
	getDeploymentRepoSlug,
	getDeploymentPlatform,
	getDeploymentService,
	getRuntimeVersion,
	getDeploymentIdentity,
	deploymentIdentity,
	isPreviewEnvironment,
	isProductionLikeEnvironment,
	_resetLocalGitShaCache,
};
