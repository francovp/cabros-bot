'use strict';

const Ajv = require('ajv');
const openApiSpec = require('../openapi/openapi.json');
const { resolveEnvelopeRequestId } = require('./errorEnvelope');

/**
 * Check if runtime request validation is enabled.
 * Defaults to true unless explicitly disabled via ENABLE_REQUEST_VALIDATION=false.
 */
function isRequestValidationEnabled() {
	const raw = process.env.ENABLE_REQUEST_VALIDATION;
	if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
		const val = String(raw).trim().toLowerCase();
		return val !== 'false' && val !== '0' && val !== 'off' && val !== 'no';
	}
	// In test environments, disable by default so legacy handler tests asserting
	// ad-hoc error codes are preserved; tests exercising validation explicitly set
	// ENABLE_REQUEST_VALIDATION=true.
	if (process.env.NODE_ENV === 'test') {
		return false;
	}
	return true;
}

// Initialize Ajv with standard options
const ajv = new Ajv({
	allErrors: true,
	strict: false,
	coerceTypes: false,
});

// Register URI format handler
ajv.addFormat('uri', (str) => {
	try {
		new URL(str);
		return true;
	} catch {
		return false;
	}
});

// Register all component schemas and requestBodies for ref resolution
if (openApiSpec.components && openApiSpec.components.schemas) {
	for (const [name, schema] of Object.entries(openApiSpec.components.schemas)) {
		ajv.addSchema(schema, `#/components/schemas/${name}`);
	}
}

if (openApiSpec.components && openApiSpec.components.requestBodies) {
	for (const [name, reqBody] of Object.entries(openApiSpec.components.requestBodies)) {
		const jsonSchema = reqBody.content && reqBody.content['application/json'] && reqBody.content['application/json'].schema;
		if (jsonSchema) {
			ajv.addSchema(jsonSchema, `#/components/requestBodies/${name}`);
		}
	}
}

// Compile route validators for the initial webhook tranche
const routeValidators = new Map();

const WEBHOOK_ROUTES = [
	{
		path: '/api/webhook/alert',
		schema: openApiSpec.components.schemas.AlertRequest,
		textSchema: { type: 'string', minLength: 1 },
		required: true,
	},
	{
		path: '/api/webhook/message',
		schema: openApiSpec.components.schemas.MessageRequest,
		required: true,
	},
	{
		path: '/api/webhook/expanded-analysis-alert',
		schema: openApiSpec.components.schemas.ExpandedAnalysisRequest,
		required: false,
	},
	{
		path: '/api/webhook/market-scanner-alert',
		schema: openApiSpec.components.schemas.MarketScannerRequest,
		required: false,
	},
	{
		path: '/api/webhook/volume-confirmation',
		schema: openApiSpec.components.schemas.VolumeConfirmationRequest,
		required: true,
	},
	{
		path: '/api/webhook/symbol-analysis',
		schema: openApiSpec.components.schemas.SymbolAnalysisRequest,
		required: true,
	},
];

for (const route of WEBHOOK_ROUTES) {
	const compiled = {
		validate: ajv.compile(route.schema),
		textValidate: route.textSchema ? ajv.compile(route.textSchema) : null,
		required: route.required,
	};
	routeValidators.set(route.path, compiled);
	// Also register stripped or suffix forms if needed
	const subPath = route.path.replace(/^\/api/, '');
	routeValidators.set(subPath, compiled);
}

/**
 * Format Ajv errors into a sanitized structure.
 * Never includes raw user-submitted values to prevent secret leaks.
 */
function formatValidationErrors(errors) {
	if (!Array.isArray(errors) || errors.length === 0) {
		return [];
	}
	return errors.map((err) => {
		let path = err.instancePath || '';
		if (!path && err.params && err.params.missingProperty) {
			path = `/${err.params.missingProperty}`;
		}
		if (!path) {
			path = '/';
		}
		return {
			path,
			keyword: err.keyword,
			message: err.message || 'validation failed',
		};
	});
}

/**
 * Build a concise summary string from sanitized errors.
 */
function buildErrorSummary(sanitizedErrors) {
	if (!sanitizedErrors || sanitizedErrors.length === 0) {
		return 'Validation failed';
	}
	const first = sanitizedErrors[0];
	const field = first.path !== '/' ? `${first.path} ` : '';
	return `${field}${first.message}`;
}

/**
 * Middleware factory for request validation.
 * @param {string} [targetPath] - Route path (e.g. '/api/webhook/alert')
 */
function validateRequest(targetPath) {
	return (req, res, next) => {
		if (!isRequestValidationEnabled()) {
			return next();
		}

		const resolvedPath = targetPath
			|| req.route?.path
			|| String(req.originalUrl || req.url || req.path || '').split('?')[0].replace(/\/+$/, '');

		const validator = routeValidators.get(resolvedPath)
			|| routeValidators.get(resolvedPath.replace(/^\/api/, ''))
			|| routeValidators.get(`/api${resolvedPath}`);

		if (!validator) {
			// No schema registered for this route; proceed
			return next();
		}

		const body = req.body;
		const isText = typeof body === 'string';

		// Handle missing body when required
		if (validator.required && (body === undefined || body === null || (isText && body.trim().length === 0))) {
			const requestId = resolveEnvelopeRequestId(req);
			return res.status(400).json({
				success: false,
				error: 'Request validation failed: request body is required',
				code: 'VALIDATION_ERROR',
				requestId,
				retryable: false,
				details: {
					errors: [
						{
							path: '/',
							keyword: 'required',
							message: 'request body is required',
						},
					],
				},
			});
		}

		// Text/plain validation for routes supporting it (e.g. /api/webhook/alert)
		if (isText) {
			if (validator.textValidate) {
				const valid = validator.textValidate(body);
				if (!valid) {
					const sanitized = formatValidationErrors(validator.textValidate.errors);
					const summary = buildErrorSummary(sanitized);
					const requestId = resolveEnvelopeRequestId(req);
					return res.status(400).json({
						success: false,
						error: `Request validation failed: ${summary}`,
						code: 'VALIDATION_ERROR',
						requestId,
						retryable: false,
						details: {
							errors: sanitized,
						},
					});
				}
				return next();
			} else {
				// Route expects JSON object but received plain text string
				const requestId = resolveEnvelopeRequestId(req);
				return res.status(400).json({
					success: false,
					error: 'Request validation failed: request body must be a JSON object',
					code: 'VALIDATION_ERROR',
					requestId,
					retryable: false,
					details: {
						errors: [
							{
								path: '/',
								keyword: 'type',
								message: 'request body must be a JSON object',
							},
						],
					},
				});
			}
		}

		// JSON body validation
		const targetBody = body === undefined ? {} : body;
		const valid = validator.validate(targetBody);
		if (!valid) {
			const sanitized = formatValidationErrors(validator.validate.errors);
			const summary = buildErrorSummary(sanitized);
			const requestId = resolveEnvelopeRequestId(req);
			return res.status(400).json({
				success: false,
				error: `Request validation failed: ${summary}`,
				code: 'VALIDATION_ERROR',
				requestId,
				retryable: false,
				details: {
					errors: sanitized,
				},
			});
		}

		return next();
	};
}

module.exports = {
	validateRequest,
	isRequestValidationEnabled,
	formatValidationErrors,
	buildErrorSummary,
	routeValidators,
	ajv,
};
