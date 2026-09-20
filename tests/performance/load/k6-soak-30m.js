import http from 'k6/http';
import { check } from 'k6';
import { Counter, Gauge, Trend } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL || 'http://127.0.0.1:18080';
const apiKey = __ENV.WEBHOOK_API_KEY || 'performance-test-key';
const channel429 = new Counter('channel_429_count');
const heapUsed = new Gauge('heap_used_bytes');
const rss = new Gauge('rss_bytes');
const eventLoopLag = new Trend('event_loop_lag_ms');
const cases = [
	{ name: 'alert', path: '/api/webhook/alert?dryRun=true', body: { text: 'BTCUSDT(240) señal de COMPRA' } },
	{ name: 'expanded-analysis', path: '/api/webhook/expanded-analysis-alert?dryRun=true', body: { symbols: ['BINANCE:BTCUSDT'] } },
	{ name: 'market-scanner', path: '/api/webhook/market-scanner-alert', body: { scans: ['gainers'], dryRun: true } },
	{ name: 'jobs', path: '/api/jobs/tradingview-analysis', body: {} },
	{ name: 'news-monitor', path: '/api/news-monitor', body: { crypto: ['BTCUSDT'], dryRun: true } },
];

export const options = {
	scenarios: {
		soak: { executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: '30m', preAllocatedVUs: 10, maxVUs: 50 },
	},
	thresholds: {
		'http_req_duration{endpoint:alert}': ['p(95)<250', 'p(99)<500'],
		'http_req_duration{endpoint:expanded-analysis}': ['p(95)<4000', 'p(99)<8000'],
		'http_req_duration{endpoint:market-scanner}': ['p(95)<4000', 'p(99)<8000'],
		'http_req_duration{endpoint:jobs}': ['p(95)<150', 'p(99)<300'],
		'http_req_duration{endpoint:news-monitor}': ['p(95)<150', 'p(99)<300'],
	},
};

export default function () {
	const request = cases[(__VU + __ITER) % cases.length];
	const response = http.post(`${baseUrl}${request.path}`, JSON.stringify(request.body), {
		headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
		tags: { endpoint: request.name },
	});
	if (response.status === 429) channel429.add(1, { endpoint: request.name });
	check(response, { 'endpoint returned an HTTP response': (result) => result.status > 0 });

	const diagnostics = http.get(`${baseUrl}/diag`, {
		headers: { 'x-api-key': apiKey },
		tags: { endpoint: 'diag' },
	});
	if (diagnostics.status === 200) {
		const body = diagnostics.json();
		heapUsed.add(body.heapUsedBytes);
		rss.add(body.rssBytes);
		eventLoopLag.add(body.eventLoopLagMs);
	}
}
