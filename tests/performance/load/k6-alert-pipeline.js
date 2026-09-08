import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL || 'http://127.0.0.1:18080';
const apiKey = __ENV.WEBHOOK_API_KEY || 'performance-test-key';
const channel429 = new Counter('channel_429_count');
const requests = [
	{ name: 'alert', path: '/api/webhook/alert?dryRun=true', body: { text: 'BTCUSDT(240) señal de COMPRA' } },
	{ name: 'expanded-analysis', path: '/api/webhook/expanded-analysis-alert?dryRun=true', body: { symbols: ['BINANCE:BTCUSDT'] } },
	{ name: 'market-scanner', path: '/api/webhook/market-scanner-alert', body: { scans: ['gainers'], dryRun: true } },
	{ name: 'jobs', path: '/api/jobs/tradingview-analysis', body: {} },
	{ name: 'news-monitor', path: '/api/news-monitor', body: { crypto: ['BTCUSDT'], dryRun: true } },
];

export const options = {
	noConnectionReuse: false,
	scenarios: {
		rps_10: { executor: 'constant-arrival-rate', rate: 10, timeUnit: '1s', duration: '10s', preAllocatedVUs: 20, maxVUs: 50, tags: { profile: '10' } },
		rps_50: { executor: 'constant-arrival-rate', startTime: '15s', rate: 50, timeUnit: '1s', duration: '10s', preAllocatedVUs: 75, maxVUs: 150, tags: { profile: '50' } },
		rps_200: { executor: 'constant-arrival-rate', startTime: '30s', rate: 200, timeUnit: '1s', duration: '10s', preAllocatedVUs: 250, maxVUs: 500, tags: { profile: '200' } },
	},
	thresholds: {
		'http_req_duration{endpoint:alert}': ['p(95)<250'],
		'http_req_duration{endpoint:expanded-analysis}': ['p(95)<4000'],
		'http_req_duration{endpoint:market-scanner}': ['p(95)<4000'],
		'http_req_duration{endpoint:jobs}': ['p(95)<150'],
		'http_req_duration{endpoint:news-monitor}': ['p(95)<150'],
	},
};

export default function () {
	const request = requests[(__VU + __ITER) % requests.length];
	const response = http.post(`${baseUrl}${request.path}`, JSON.stringify(request.body), {
		headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
		tags: { endpoint: request.name },
	});

	if (response.status === 429) channel429.add(1, { endpoint: request.name });
	check(response, { 'endpoint returned an HTTP response': (result) => result.status > 0 });
}
