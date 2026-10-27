'use strict';

const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const openApiSpec = require('../openapi/openapi.json');
const { sendErrorFrom } = require('./errorEnvelope');

const VALIDATED_POST_PATHS = [
	'/api/webhook/alert',
	'/api/webhook/message',
	'/api/webhook/expanded-analysis-alert',
	'/api/webhook/market-scanner-alert',
	'/api/webhook/volume-confirmation',
	'/api/webhook/symbol-analysis',
];

function isRequestValidationEnabled() {
	return process.env.ENABLE_REQUEST_VALIDATION !== 'false';
}

const ajv = new Ajv2020({
	allErrors: false,
	coerceTypes: false,
	strict: false,
});
addFormats(ajv);

for (const [name, schema] of Object.entries(openApiSpec.components?.schemas || {})) {
	ajv.addSchema(schema, `#/components/schemas/${name}`);
}

function decodePointerPart(part) {
	return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveLocalReference(value) {
	let resolved = value;
	let depth = 0;
	while (resolved && typeof resolved === 'object' && typeof resolved.$ref === 'string') {
		if (!resolved.$ref.startsWith('#/')) {
			throw new Error('Request validation only supports local OpenAPI references');
		}
		if (depth++ >= 8) {
			throw new Error('OpenAPI reference chain is too deep');
		}

		resolved = resolved.$ref.slice(2).split('/').map(decodePointerPart)
			.reduce((current, key) => current && current[key], openApiSpec);
		if (!resolved) {
			throw new Error('OpenAPI reference does not resolve');
		}
	}
	return resolved;
}

function getParameterSchema(parameter) {
	if (parameter.schema) return resolveLocalReference(parameter.schema);
	const media = Object.values(parameter.content || {})[0];
	if (media?.schema) return resolveLocalReference(media.schema);
	throw new Error(`OpenAPI ${parameter.in} parameter has no schema`);
}

function compileOperationValidator(operation, pathItem = {}) {
	const parameterByKey = new Map();
	for (const parameterRef of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
		const parameter = resolveLocalReference(parameterRef);
		if (!parameter || !['query', 'path'].includes(parameter.in) || !parameter.name) continue;
		parameterByKey.set(`${parameter.in}:${parameter.name}`, parameter);
	}

	const parameters = Array.from(parameterByKey.values()).map((parameter) => ({
		...parameter,
		schema: getParameterSchema(parameter),
		validate: ajv.compile(getParameterSchema(parameter)),
	}));

	const requestBody = operation.requestBody
		? resolveLocalReference(operation.requestBody)
		: null;
	const bodyValidators = new Map();
	for (const [mediaType, media] of Object.entries(requestBody?.content || {})) {
		if (media?.schema) {
			bodyValidators.set(mediaType.toLowerCase(), ajv.compile(media.schema));
		}
	}

	return {
		parameters,
		bodyValidators,
		bodyRequired: requestBody?.required === true,
		// Keep these aliases for existing unit tests and callers that inspect the compiled schema.
		required: requestBody?.required === true,
		validate: bodyValidators.get('application/json') || bodyValidators.values().next().value,
		textValidate: bodyValidators.get('text/plain') || null,
	};
}

const routeValidators = new Map();
for (const path of VALIDATED_POST_PATHS) {
	const pathItem = openApiSpec.paths[path];
	const operation = pathItem?.post;
	if (!operation) {
		throw new Error(`OpenAPI POST operation is missing for ${path}`);
	}
	routeValidators.set(path, compileOperationValidator(operation, pathItem));
}

function escapePointerPart(value) {
	return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function formatValidationErrors(errors, location = 'body', prefix = '') {
	if (!Array.isArray(errors) || errors.length === 0) return [];
	const error = errors[0];
	let path = error.instancePath || '';
	if (error.keyword === 'required' && error.params?.missingProperty) {
		path += `/${escapePointerPart(error.params.missingProperty)}`;
	}
	if (prefix) path = `${prefix}${path}`;
	if (!path) path = '/';
	return [{
		location,
		path,
		keyword: typeof error.keyword === 'string' ? error.keyword : 'validation',
	}];
}

function normalizeParameterValue(value, parameter) {
	if (typeof value !== 'string') return value;
	const schema = parameter.schema || {};
	if (schema.type === 'boolean') {
		if (value === 'true') return true;
		if (value === 'false') return false;
		return value;
	}
	if (schema.type === 'integer' && /^-?\d+$/.test(value)) {
		const number = Number(value);
		return Number.isSafeInteger(number) ? number : value;
	}
	if (schema.type === 'number' && value.trim() !== '') {
		const number = Number(value);
		return Number.isFinite(number) ? number : value;
	}
	if (schema.type === 'array') {
		return parameter.explode === false ? value.split(',') : [value];
	}
	return value;
}

function validateParameters(parameters, req) {
	for (const parameter of parameters) {
		const source = parameter.in === 'query' ? req.query : req.params;
		const hasValue = source && Object.prototype.hasOwnProperty.call(source, parameter.name);
		if (!hasValue) {
			if (parameter.required) {
				return [{
					location: parameter.in,
					path: `/${escapePointerPart(parameter.name)}`,
					keyword: 'required',
				}];
			}
			continue;
		}

		const value = normalizeParameterValue(source[parameter.name], parameter);
		if (!parameter.validate(value)) {
			return formatValidationErrors(
				parameter.validate.errors,
				parameter.in,
				`/${escapePointerPart(parameter.name)}`,
			);
		}
	}
	return [];
}

function normalizeRequestPath(path) {
	const normalized = String(path || '').split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
	return normalized.startsWith('/webhook/') ? `/api${normalized}` : normalized;
}

function getRequestContentType(req, body, bodyValidators) {
	const header = req.headers?.['content-type'] || req.get?.('content-type');
	if (typeof header === 'string' && header.trim()) {
		return header.split(';', 1)[0].trim().toLowerCase();
	}
	if (typeof body === 'string' && bodyValidators.has('text/plain')) return 'text/plain';
	return 'application/json';
}

function sendValidationError(res, req, errors) {
	return sendErrorFrom(res, 400, {
		error: 'Request validation failed',
		code: 'VALIDATION_ERROR',
		details: { errors: errors.slice(0, 1) },
	}, { req, retryable: false });
}

function validateRequest(targetPath) {
	return (req, res, next) => {
		if (!isRequestValidationEnabled()) return next();

		const path = normalizeRequestPath(targetPath
			|| `${req.baseUrl || ''}${req.route?.path || req.path || req.originalUrl || req.url || ''}`);
		if (String(req.method || '').toUpperCase() !== 'POST') return next();
		const validator = routeValidators.get(path);
		if (!validator) return next();

		const parameterErrors = validateParameters(validator.parameters, req);
		if (parameterErrors.length > 0) return sendValidationError(res, req, parameterErrors);

		const body = req.body;
		if (body === undefined) {
			if (validator.bodyRequired) {
				return sendValidationError(res, req, [{
					location: 'body',
					path: '/',
					keyword: 'required',
				}]);
			}
			return next();
		}

		const contentType = getRequestContentType(req, body, validator.bodyValidators);
		const bodyValidator = validator.bodyValidators.get(contentType);
		if (!bodyValidator) {
			return sendValidationError(res, req, [{
				location: 'body',
				path: '/',
				keyword: 'contentType',
			}]);
		}
		if (!bodyValidator(body)) {
			return sendValidationError(res, req, formatValidationErrors(bodyValidator.errors));
		}
		return next();
	};
}

module.exports = {
	validateRequest,
	isRequestValidationEnabled,
	formatValidationErrors,
	compileOperationValidator,
	validateParameters,
	routeValidators,
	ajv,
};
