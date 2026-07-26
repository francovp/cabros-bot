'use strict';

const { createPrivateKey } = require('crypto');
const { accessSync, constants } = require('fs');

function hasValue(value) {
	return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function isGoogleManagedRuntime() {
	return (
		hasValue(process.env.K_SERVICE)
		|| hasValue(process.env.K_REVISION)
		|| hasValue(process.env.FUNCTION_TARGET)
		|| hasValue(process.env.FUNCTION_NAME)
		|| hasValue(process.env.GAE_SERVICE)
	);
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

function hasReadableCredentialsFile(path) {
	if (!hasValue(path)) {
		return false;
	}

	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch (error) {
		return false;
	}
}

function isFirestoreConfigured() {
	return (
		hasValidInlineCredentials(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
		|| hasReadableCredentialsFile(process.env.GOOGLE_APPLICATION_CREDENTIALS)
		|| isGoogleManagedRuntime()
	);
}

module.exports = {
	isFirestoreConfigured,
};
