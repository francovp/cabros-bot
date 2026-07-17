'use strict';

const VIEWS = {
	status: [{ method: 'GET', path: '/api/status', label: 'Refresh status' }],
	alerts: [{ method: 'GET', path: '/api/alerts', label: 'Load alerts' }],
	presets: [{ method: 'GET', path: '/api/scanner-presets', label: 'Load presets' }],
	jobs: [{ method: 'POST', path: '/api/jobs/tradingview-analysis', label: 'Create job' }],
	analysis: [
		{ method: 'POST', path: '/api/webhook/expanded-analysis-alert', label: 'Expanded analysis' },
		{ method: 'POST', path: '/api/webhook/market-scanner-alert', label: 'Market scanner' },
		{ method: 'POST', path: '/api/webhook/volume-confirmation', label: 'Volume confirmation' },
		{ method: 'POST', path: '/api/news-monitor', label: 'News monitor' },
	],
};

const VIEW_ACTIONS = {
	alerts: [
		{
			method: 'POST', path: '/api/alerts/{alertId}/replay', label: 'Replay alert',
			confirm: 'Replay this alert?',
		},
	],
	presets: [
		{
			method: 'POST', path: '/api/scanner-presets/{id}/run', label: 'Run preset',
			confirm: 'Run this scanner preset?',
		},
		{
			method: 'DELETE', path: '/api/scanner-presets/{id}', label: 'Delete preset',
			confirm: 'Delete this scanner preset?',
		},
	],
	jobs: [
		{ method: 'GET', path: '/api/jobs/{jobId}', label: 'Get job status' },
		{
			method: 'POST', path: '/api/jobs/{jobId}/cancel', label: 'Cancel job',
			confirm: 'Cancel this job?',
		},
		{
			method: 'POST', path: '/api/jobs/{jobId}/retry', label: 'Retry job',
			confirm: 'Retry this job?',
		},
	],
};

const contractPromise = fetch('/openapi.json').then((response) => {
	if (!response.ok) throw new Error(`OpenAPI contract returned HTTP ${response.status}`);
	return response.json();
});

const element = (tag, options = {}) => {
	const node = document.createElement(tag);
	if (options.className) node.className = options.className;
	if (options.text) node.textContent = options.text;
	return node;
};

const parseJson = (value, label) => {
	if (!value.trim()) return undefined;
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`${label} must be valid JSON: ${error.message}`);
	}
};

const resolveRef = (contract, value) => {
	if (!value || !value.$ref) return value;
	return value.$ref.slice(2).split('/').reduce((current, key) => current[key], contract);
};

const getOperation = (contract, definition) => contract.paths[definition.path]
	&& contract.paths[definition.path][definition.method.toLowerCase()];

const getParameters = (contract, operation) => (operation && operation.parameters || [])
	.map((parameter) => resolveRef(contract, parameter));

const getBodyExample = (contract, operation) => {
	const requestBody = resolveRef(contract, operation && operation.requestBody);
	const json = requestBody && requestBody.content && requestBody.content['application/json'];
	if (!json) return {};
	if (json.example !== undefined) return json.example;
	const firstExample = json.examples && Object.values(json.examples)[0];
	return firstExample && firstExample.value || {};
};

const getQueryExample = (contract, operation) => Object.fromEntries(getParameters(contract, operation)
	.filter((parameter) => parameter.in === 'query' && (parameter.example !== undefined
		|| parameter.schema && (parameter.schema.example !== undefined || parameter.schema.default !== undefined)))
	.map((parameter) => [parameter.name, parameter.example !== undefined
		? parameter.example
		: parameter.schema.example !== undefined ? parameter.schema.example : parameter.schema.default]));

const addJsonField = (form, labelText, name, value) => {
	const label = element('label', { text: labelText });
	const textarea = element('textarea');
	textarea.name = name;
	textarea.rows = 8;
	textarea.value = JSON.stringify(value, null, 2);
	label.append(textarea);
	form.append(label);
};

const addPathFields = (form, path) => {
	const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
	names.forEach((name) => {
		const label = element('label', { text: name });
		const input = element('input');
		input.name = `path-${name}`;
		input.required = true;
		input.placeholder = name;
		label.append(input);
		form.append(label);
	});
	return names;
};

const fillPath = (path, names, form) => names.reduce((resolved, name) => resolved.replace(
	`{${name}}`,
	encodeURIComponent(form.elements[`path-${name}`].value),
), path);

const showError = (output, message) => {
	output.className = 'response-block response-error';
	output.textContent = message;
};

const redactApiKey = (value, apiKey) => apiKey
	? String(value).split(apiKey).join('[REDACTED]')
	: String(value);

const sendRequest = async ({ definition, path, query, body, button, output }) => {
	const apiKey = document.getElementById('api-key').value;
	const summary = redactApiKey(`${definition.method} ${path}`, apiKey);
	let request;
	try {
		request = window.CabrosAdminRequest.createRequest({
			path,
			method: definition.method,
			query,
			body,
			apiKey,
		});
	} catch (error) {
		showError(output, error.message);
		return;
	}

	if (definition.confirm && !window.confirm(definition.confirm)) return;

	button.disabled = true;
	output.className = 'response-block request-state';
	output.textContent = `${summary}\nRequest in progress…`;
	const started = performance.now();
	try {
		const response = await fetch(request.url, request.options);
		const elapsed = Math.round(performance.now() - started);
		const text = await response.text();
		let formatted = text || '(empty response)';
		try {
			formatted = JSON.stringify(JSON.parse(text), null, 2);
		} catch (_) {
			// Non-JSON responses stay readable as text.
		}
		output.className = `response-block${response.ok ? '' : ' response-error'}`;
		output.textContent = `${summary}\nHTTP ${response.status} · ${elapsed} ms\n\n${redactApiKey(formatted, apiKey)}`;
	} catch (error) {
		const elapsed = Math.round(performance.now() - started);
		showError(output, `${summary}\nNetwork error · ${elapsed} ms\n\n${redactApiKey(error.message, apiKey)}`);
	} finally {
		button.disabled = false;
	}
};

const createOperationForm = (contract, definition) => {
	const operation = getOperation(contract, definition);
	const form = element('form', { className: 'operation-card' });
	const title = element('h3', { text: definition.label });
	const route = element('code', { text: `${definition.method} ${definition.path}` });
	form.append(title, route);
	const pathNames = addPathFields(form, definition.path);

	if (definition.method === 'GET') {
		addJsonField(form, 'Query JSON', 'query', getQueryExample(contract, operation));
	} else if (operation && operation.requestBody) {
		addJsonField(form, 'Request body JSON', 'body', getBodyExample(contract, operation));
	}

	const button = element('button', { text: definition.label });
	button.type = 'submit';
	if (definition.confirm) button.className = 'destructive-action';
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	form.append(button, output);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		try {
			const query = form.elements.query ? parseJson(form.elements.query.value, 'Query') : undefined;
			const body = form.elements.body ? parseJson(form.elements.body.value, 'Request body') : undefined;
			sendRequest({
				definition,
				path: fillPath(definition.path, pathNames, form),
				query,
				body,
				button,
				output,
			});
		} catch (error) {
			showError(output, error.message);
		}
	});
	return form;
};

const operationDefinitions = (contract) => Object.entries(contract.paths).flatMap(([path, methods]) => Object.entries(methods)
	.filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
	.map(([method, operation]) => ({
		method: method.toUpperCase(),
		path,
		label: operation.summary || `${method.toUpperCase()} ${path}`,
	})))
	.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));

const renderPlayground = (contract, view) => {
	const form = element('form', { className: 'operation-card playground' });
	form.append(element('h2', { text: 'Playground' }));
	const selectLabel = element('label', { text: 'Operation' });
	const select = element('select');
	const definitions = operationDefinitions(contract);
	definitions.forEach((definition, index) => {
		const option = element('option', { text: `${definition.method} ${definition.path} — ${definition.label}` });
		option.value = index;
		select.append(option);
	});
	selectLabel.append(select);
	const fields = element('div', { className: 'form-fields' });
	const button = element('button', { text: 'Send request' });
	button.type = 'submit';
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	form.append(selectLabel, fields, button, output);
	view.append(form);

	const renderFields = () => {
		fields.replaceChildren();
		const definition = definitions[Number(select.value)];
		const operation = getOperation(contract, definition);
		addPathFields(fields, definition.path);
		addJsonField(fields, 'Query JSON', 'query', getQueryExample(contract, operation));
		addJsonField(fields, 'Request body JSON', 'body', getBodyExample(contract, operation));
	};

	select.addEventListener('change', renderFields);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		try {
			const definition = definitions[Number(select.value)];
			const pathNames = [...definition.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
			sendRequest({
				definition,
				path: fillPath(definition.path, pathNames, form),
				query: parseJson(form.elements.query.value, 'Query'),
				body: parseJson(form.elements.body.value, 'Request body'),
				button,
				output,
			});
		} catch (error) {
			showError(output, error.message);
		}
	});
	renderFields();
};

const renderView = async (name) => {
	const view = document.getElementById('view');
	view.replaceChildren(element('p', { className: 'request-state', text: 'Loading API contract…' }));
	try {
		const contract = await contractPromise;
		view.replaceChildren();
		if (name === 'playground') {
			renderPlayground(contract, view);
			return;
		}
		view.append(element('h2', { text: name[0].toUpperCase() + name.slice(1) }));
		[...(VIEWS[name] || []), ...(VIEW_ACTIONS[name] || [])]
			.forEach((definition) => view.append(createOperationForm(contract, definition)));
	} catch (error) {
		showError(view, `Unable to load the API contract: ${error.message}`);
	}
};

document.addEventListener('DOMContentLoaded', () => {
	const apiKey = document.getElementById('api-key');
	const keyState = document.getElementById('key-state');
	try {
		apiKey.value = sessionStorage.getItem('cabros-admin-api-key') || '';
	} catch (_) {
		keyState.textContent = 'Session storage is unavailable; the key will remain in this tab only.';
	}

	document.getElementById('save-key').addEventListener('click', () => {
		try {
			sessionStorage.setItem('cabros-admin-api-key', apiKey.value);
			keyState.textContent = 'API key saved for this browser session.';
		} catch (error) {
			keyState.textContent = `Could not save the API key: ${error.message}`;
		}
	});

	document.getElementById('clear-key').addEventListener('click', () => {
		apiKey.value = '';
		try {
			sessionStorage.removeItem('cabros-admin-api-key');
			keyState.textContent = 'API key cleared.';
		} catch (error) {
			keyState.textContent = `API key cleared from the form; session storage failed: ${error.message}`;
		}
	});

	document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
		document.querySelectorAll('[data-view]').forEach((item) => item.removeAttribute('aria-current'));
		button.setAttribute('aria-current', 'page');
		renderView(button.dataset.view);
	}));

	renderView('status');
});
