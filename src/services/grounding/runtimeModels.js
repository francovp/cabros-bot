'use strict';

const {
	FORCE_BRAVE_SEARCH,
	GEMINI_MODEL_NAME,
	GEMINI_MODEL_NAME_FALLBACK,
	GROUNDING_MODEL_NAME,
} = require('./config');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

function getGroundingModelName() {
	if (FORCE_BRAVE_SEARCH) {
		return 'brave-search';
	}
	return getRuntimeConfig().GROUNDING_MODEL_NAME || GROUNDING_MODEL_NAME;
}

function getGeminiModelName() {
	return getRuntimeConfig().GEMINI_MODEL_NAME || GEMINI_MODEL_NAME || null;
}

function getGeminiFallbackModelName() {
	return getRuntimeConfig().GEMINI_MODEL_NAME_FALLBACK || GEMINI_MODEL_NAME_FALLBACK;
}

module.exports = {
	getGroundingModelName,
	getGeminiModelName,
	getGeminiFallbackModelName,
};
