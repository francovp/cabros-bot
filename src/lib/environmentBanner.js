'use strict';

/**
 * Environment banner middleware.
 *
 * Injects non-sensitive X-Cabros-* response headers on every request so
 * operators and external integrators can immediately tell which deployment
 * answered a call. Honors the opt-in `ENABLE_ENVIRONMENT_BANNER` flag
 * (default `true`) so preview/staging can be visually distinguished from
 * production without exposing any secret value.
 */

const packageJson = require('../../package.json');
const {
	getDeploymentCommit,
	isPreviewEnvironment,
	isProductionLikeEnvironment,
} = require('./deploymentEnvironment');

const BANNER_HEADER_ENVIRONMENT = 'X-Cabros-Environment';
const BANNER_HEADER_COMMIT = 'X-Cabros-Commit';
const BANNER_HEADER_SERVICE = 'X-Cabros-Service';

function isEnvironmentBannerEnabled(env = process.env) {
	const raw = env.ENABLE_ENVIRONMENT_BANNER;
	if (raw === undefined || raw === null || raw === '') return true;
	return String(raw).trim().toLowerCase() !== 'false';
}

function resolveEnvironmentBannerEnvironment(env = process.env) {
	if (env.SENTRY_ENVIRONMENT) {
		return env.SENTRY_ENVIRONMENT;
	}
	if (isPreviewEnvironment(env)) {
		return 'preview';
	}
	if (isProductionLikeEnvironment(env)) {
		return 'production';
	}
	return env.NODE_ENV || 'development';
}

function getEnvironmentBannerMetadata(env = process.env) {
	const commit = getDeploymentCommit(env);
	const shortCommit = commit && typeof commit === 'string' ? commit.slice(0, 8) : null;
	return {
		environment: resolveEnvironmentBannerEnvironment(env),
		commit,
		shortCommit,
		name: env.SERVICE_NAME || packageJson.name || 'cabros-bot',
	};
}

function getEnvironmentBannerPayload(env = process.env) {
	const metadata = getEnvironmentBannerMetadata(env);
	const deployedAt = env.RAILWAY_DEPLOYMENT_ID
		|| env.RENDER_DEPLOY_ID
		|| env.VERCEL_DEPLOYMENT_ID
		|| env.RENDER_GIT_COMMIT_DATE
		|| env.RAILWAY_GIT_COMMIT_DATE
		|| null;
	return {
		environment: metadata.environment,
		commit: metadata.commit,
		name: metadata.name,
		deployedAt,
	};
}

function buildEnvironmentBannerMiddleware(env = process.env) {
	const enabled = isEnvironmentBannerEnabled(env);
	return function environmentBannerMiddleware(req, res, next) {
		if (!enabled) return next();
		const metadata = getEnvironmentBannerMetadata(env);
		res.setHeader(BANNER_HEADER_ENVIRONMENT, metadata.environment);
		if (metadata.commit) {
			res.setHeader(BANNER_HEADER_COMMIT, metadata.shortCommit || metadata.commit);
		}
		res.setHeader(BANNER_HEADER_SERVICE, metadata.name);
		return next();
	};
}

module.exports = {
	BANNER_HEADER_COMMIT,
	BANNER_HEADER_ENVIRONMENT,
	BANNER_HEADER_SERVICE,
	buildEnvironmentBannerMiddleware,
	getEnvironmentBannerMetadata,
	getEnvironmentBannerPayload,
	isEnvironmentBannerEnabled,
	resolveEnvironmentBannerEnvironment,
};