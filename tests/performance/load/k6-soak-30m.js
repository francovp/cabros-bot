import http from 'k6/http';
import { check } from 'k6';
import { Counter, Gauge, Trend } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL || 'http://127.0.0.1:18080';
const apiKey = __ENV.WEBHOOK_API_KEY || 'performance-test-key';
const budgets = JSON.parse(open(import.meta.resolve('../budgets.json')));
const requests = JSON.parse(open(import.meta.resolve('../request-cases.json')));
const channel429 = new Counter('channel_429_count');
const heapUsed = new Gauge('heap_used_bytes');
const rss = new Gauge('rss_bytes');
const eventLoopLag = new Trend('event_loop_lag_ms');

function buildThresholds() {
	const thresholds = {
		checks: ['rate==1'],
		dropped_iterations: ['count<1'],
		channel_429_count: ['count<1'],
	};
	for (const budget of Object.values(budgets)) {
		thresholds[`http_req_duration{endpoint:${budget.name}}`] = [
			`p(95)<${budget.p95Ms}`,
			`p(99)<${budget.p99Ms}`,
		];
	}
	return thresholds;
}

function valueAtPath(value, path) {
	return path.split('.').reduce((current, key) => current === undefined || current === null ? undefined : current[key], value);
}

function hasSuccessContract(response, contract) {
	if (response.status !== contract.expectedStatus) return false;
	try {
		const body = response.json();
		for (const [key, expected] of Object.entries(contract.expectedBody || {})) {
			if (body[key] !== expected) return false;
		}
		for (const [path, expected] of Object.entries(contract.expectedBodyPaths || {})) {
			if (valueAtPath(body, path) !== expected) return false;
		}
		for (const path of contract.expectedStringPaths || []) {
			const value = valueAtPath(body, path);
			if (typeof value !== 'string' || value.length === 0) return false;
		}
		return true;
	} catch (_) {
		return false;
	}
}

export const options = {
	scenarios: {
		soak: { executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: '30m', preAllocatedVUs: 10, maxVUs: 50 },
	},
	thresholds: buildThresholds(),
};

export default function () {
	const request = requests[(__VU + __ITER) % requests.length];
	const response = http.post(`${baseUrl}${request.path}`, JSON.stringify(request.body), {
		headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
		tags: { endpoint: request.name },
	});
	if (response.status === 429) channel429.add(1, { endpoint: request.name });
	check(response, { [`${request.name} returned its success contract`]: (result) => hasSuccessContract(result, request) });

	const diagnostics = http.get(`${baseUrl}/diag`, {
		headers: { 'x-api-key': apiKey },
		tags: { endpoint: 'diag' },
	});
	let diagnosticsBody;
	try {
		diagnosticsBody = diagnostics.json();
	} catch (_) {
		diagnosticsBody = null;
	}
	const diagnosticsValid = diagnostics.status === 200
		&& diagnosticsBody?.success === true
		&& typeof diagnosticsBody.heapUsedBytes === 'number'
		&& typeof diagnosticsBody.rssBytes === 'number'
		&& typeof diagnosticsBody.eventLoopLagMs === 'number';
	check(diagnostics, { 'protected /diag returned diagnostics': () => diagnosticsValid });
	if (diagnosticsValid) {
		heapUsed.add(diagnosticsBody.heapUsedBytes);
		rss.add(diagnosticsBody.rssBytes);
		eventLoopLag.add(diagnosticsBody.eventLoopLagMs);
	}
}
