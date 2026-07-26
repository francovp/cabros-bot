'use strict';

const { createPrivateKey } = require('crypto');
const { accessSync, constants, readFileSync, statSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');

function hasValue(value) {
	return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function hasProjectId() {
	return hasValue(process.env.FIREBASE_PROJECT_ID)
		|| hasValue(process.env.GOOGLE_CLOUD_PROJECT)
		|| hasValue(process.env.GCLOUD_PROJECT);
}

function isGoogleManagedRuntime() {
	return (
		hasValue(process.env.K_SERVICE)
		|| hasValue(process.env.K_REVISION)
		|| hasValue(process.env.FUNCTION_TARGET)
		|| hasValue(process.env.FUNCTION_NAME)
		|| hasValue(process.env.GAE_SERVICE)
		|| ((hasValue(process.env.GCE_METADATA_HOST) || hasValue(process.env.GCE_METADATA_IP)) && hasProjectId())
	);
}

function getWellKnownCredentialsPath() {
	const homeDirectory = hasValue(process.env.HOME) ? process.env.HOME : homedir();
	return join(homeDirectory, '.config', 'gcloud', 'application_default_credentials.json');
}

function hasValidInlineCredentials(value) {
	if (!hasValue(value)) {
		return false;
	}

	try {
		const parsed = JSON.parse(value);
		const projectId = parsed.projectId || parsed.project_id;
		const clientEmail = parsed.clientEmail || parsed.client_email;
		const privateKey = parsed.privateKey || parsed.private_key;

		if (!hasValue(projectId) || !hasValue(clientEmail) || !hasValue(privateKey)) {
			return false;
		}

		createPrivateKey({ key: privateKey, format: 'pem' });
		return true;
	} catch (error) {
		return false;
	}
}

function hasValidApplicationDefaultCredentials(value) {
	if (!hasValue(value)) {
		return false;
	}

	try {
		const parsed = JSON.parse(value);
		if (parsed.type === 'authorized_user') {
			return hasValue(parsed.client_id)
				&& hasValue(parsed.client_secret)
				&& hasValue(parsed.refresh_token)
				&& hasProjectId();
		}

		return parsed.type === 'service_account' && hasValidInlineCredentials(value);
	} catch (error) {
		return false;
	}
}

function hasReadableCredentialsFile(path) {
	if (!hasValue(path)) {
		return false;
	}

	try {
		accessSync(path, constants.R_OK);
		if (!statSync(path).isFile()) {
			return false;
		}

		return hasValidApplicationDefaultCredentials(readFileSync(path, 'utf8'));
	} catch (error) {
		return false;
	}
}

function isFirestoreConfigured() {
	if (hasValue(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) {
		return hasValidInlineCredentials(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
	}

	if (hasValue(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
		return hasReadableCredentialsFile(process.env.GOOGLE_APPLICATION_CREDENTIALS);
	}

	return hasReadableCredentialsFile(getWellKnownCredentialsPath()) || isGoogleManagedRuntime();
}

module.exports = {
	isFirestoreConfigured,
};
