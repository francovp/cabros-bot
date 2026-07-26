'use strict';

const { createPrivateKey } = require('crypto');
const { accessSync, constants, readFileSync, statSync } = require('fs');

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

		if (parsed.type === 'external_account') {
			const credentialSource = parsed.credential_source;
			const hasFileOrUrlSource = credentialSource
				&& (hasValue(credentialSource.file) || hasValue(credentialSource.url));
			const hasExecutableSource = credentialSource
				&& credentialSource.executable
				&& hasValue(credentialSource.executable.command);
			const hasAwsSource = credentialSource
				&& hasValue(credentialSource.environment_id)
				&& hasValue(credentialSource.region_url)
				&& hasValue(credentialSource.regional_cred_verification_url);

			return hasValue(parsed.audience)
				&& hasValue(parsed.subject_token_type)
				&& hasValue(parsed.token_url)
				&& (hasFileOrUrlSource || hasExecutableSource || hasAwsSource);
		}

		return hasValidInlineCredentials(value);
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
	return (
		hasValidInlineCredentials(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
		|| hasReadableCredentialsFile(process.env.GOOGLE_APPLICATION_CREDENTIALS)
		|| isGoogleManagedRuntime()
	);
}

module.exports = {
	isFirestoreConfigured,
};
