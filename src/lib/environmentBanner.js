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
	resolveDeploymentEnvironment,
} = require('./deploymentEnvironment');

const BANNER_HEADER_ENVIRONMENT = 'X-Cabros-Environment';
const BANNER_HEADER_COMMIT = 'X-Cabros-Commit';
const BANNER_HEADER_SERVICE = 'X-Cabros-Service';

function isEnvironmentBannerEnabled(env = process.env) {
	if (env === process.env) {
		try {
			const { getRuntimeConfig } = require('../services/remoteConfig/RemoteConfigService');
			return getRuntimeConfig().ENABLE_ENVIRONMENT_BANNER;
		} catch (_) {
			// Metadata is optional; keep the environment fallback if config is unavailable.
		}
	}
	const raw = env.ENABLE_ENVIRONMENT_BANNER;
	if (raw === undefined || raw === null || raw === '') return true;
	return String(raw).trim().toLowerCase() !== 'false';
}

function resolveEnvironmentBannerEnvironment(env = process.env) {
	return resolveDeploymentEnvironment(env);
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
	const rawTimestamp = env.RENDER_GIT_COMMIT_DATE || env.RAILWAY_GIT_COMMIT_DATE || env.VERCEL_GIT_COMMIT_DATE;
	const deployedAt = rawTimestamp && Number.isFinite(Date.parse(rawTimestamp)) ? new Date(rawTimestamp).toISOString() : null;
	return {
		environment: metadata.environment,
		commit: metadata.commit,
		name: metadata.name,
		deployedAt,
	};
}

function setSafeHeader(res, name, value) {
	// Optional metadata must never turn an otherwise valid alert request into a 500.
	if (typeof value === 'string' && value.length <= 256 && /^[\x20-\x7e]+$/.test(value)) {
		res.setHeader(name, value);
	}
}

function appendEnvironmentFooter(extraText, env = process.env) {
	const { getRuntimeConfig } = require('../services/remoteConfig/RemoteConfigService');
	if (!getRuntimeConfig().ENABLE_MESSAGE_FOOTER_METADATA) return extraText;
	const metadata = getEnvironmentBannerMetadata(env);
	if (metadata.environment === 'production') return extraText;
	const { escapeRiskFieldValue } = require('../services/notification/formatters/markdownV2Formatter');
	const line = escapeRiskFieldValue(`(env: ${metadata.environment} @ ${metadata.shortCommit || 'unknown'})`);
	return extraText ? `${extraText}\n${line}` : line;
}

function buildEnvironmentBannerMiddleware(env = process.env) {
	return function environmentBannerMiddleware(req, res, next) {
		if (!isEnvironmentBannerEnabled(env)) return next();
		const metadata = getEnvironmentBannerMetadata(env);
		setSafeHeader(res, BANNER_HEADER_ENVIRONMENT, metadata.environment);
		if (metadata.commit) {
			setSafeHeader(res, BANNER_HEADER_COMMIT, metadata.shortCommit || metadata.commit);
		}
		setSafeHeader(res, BANNER_HEADER_SERVICE, metadata.name);
		return next();
	};
}

module.exports = {
	appendEnvironmentFooter,
	BANNER_HEADER_COMMIT,
	BANNER_HEADER_ENVIRONMENT,
	BANNER_HEADER_SERVICE,
	buildEnvironmentBannerMiddleware,
	getEnvironmentBannerMetadata,
	getEnvironmentBannerPayload,
	isEnvironmentBannerEnabled,
	resolveEnvironmentBannerEnvironment,
};
