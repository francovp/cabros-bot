const crypto = require('crypto');
const { validateWebhookSignature } = require('../../src/lib/auth');

function sign({ secret, timestamp, method = 'POST', path = '/api/webhook/alert?foo=bar', body = '{"text":"hello"}' }) {
	return `sha256=${crypto.createHmac('sha256', secret)
		.update(`${timestamp}\n${method}\n${path}\n${body}`)
		.digest('hex')}`;
}

function response() {
	return {
		status: jest.fn().mockReturnThis(),
		json: jest.fn(),
	};
}

describe('validateWebhookSignature', () => {
	const secret = 'signing-secret';

	beforeEach(() => {
		process.env.WEBHOOK_SIGNING_SECRET = secret;
		process.env.WEBHOOK_SIGNING_TOLERANCE_MS = '300000';
	});

	afterEach(() => {
		delete process.env.WEBHOOK_SIGNING_SECRET;
		delete process.env.WEBHOOK_SIGNING_TOLERANCE_MS;
	});

	it('accepts a signature over the raw request contract', () => {
		const timestamp = String(Date.now());
		const body = '{"text":"hello"}';
		const req = {
			method: 'POST',
			originalUrl: '/api/webhook/alert?foo=bar',
			rawBody: Buffer.from(body),
			headers: {
				'x-webhook-timestamp': timestamp,
				'x-webhook-signature': sign({ secret, timestamp, body }),
			},
		};
		const res = response();
		const next = jest.fn();

		validateWebhookSignature(req, res, next);

		expect(next).toHaveBeenCalledTimes(1);
		expect(res.status).not.toHaveBeenCalled();
	});

	it('rejects unsigned requests with 401', () => {
		const res = response();
		validateWebhookSignature({ headers: {} }, res, jest.fn());

		expect(res.status).toHaveBeenCalledWith(401);
		expect(res.json).toHaveBeenCalledWith({
			error: 'Unauthorized: Missing webhook signature',
			code: 'WEBHOOK_SIGNATURE_MISSING',
		});
	});

	it('rejects tampered requests with 403', () => {
		const timestamp = String(Date.now());
		const res = response();
		validateWebhookSignature({
			method: 'POST',
			originalUrl: '/api/webhook/alert',
			rawBody: Buffer.from('{"text":"tampered"}'),
			headers: {
				'x-webhook-timestamp': timestamp,
				'x-webhook-signature': sign({ secret, timestamp, body: '{"text":"original"}' }),
			},
		}, res, jest.fn());

		expect(res.status).toHaveBeenCalledWith(403);
		expect(res.json).toHaveBeenCalledWith({
			error: 'Forbidden: Invalid webhook signature',
			code: 'WEBHOOK_SIGNATURE_INVALID',
		});
	});

	it('rejects expired timestamps with 403', () => {
		const timestamp = String(Date.now() - 300001);
		const res = response();
		validateWebhookSignature({
			method: 'POST',
			originalUrl: '/api/webhook/alert',
			rawBody: Buffer.from(''),
			headers: {
				'x-webhook-timestamp': timestamp,
				'x-webhook-signature': sign({ secret, timestamp, body: '' }),
			},
		}, res, jest.fn());

		expect(res.status).toHaveBeenCalledWith(403);
		expect(res.json).toHaveBeenCalledWith({
			error: 'Forbidden: Invalid webhook signature',
			code: 'WEBHOOK_SIGNATURE_INVALID',
		});
	});

	it('rejects a replayed signature with 403 WEBHOOK_SIGNATURE_REPLAY', () => {
		const timestamp = String(Date.now());
		const body = '{"text":"hello"}';
		const req = {
			method: 'POST',
			originalUrl: '/api/webhook/alert',
			rawBody: Buffer.from(body),
			headers: {
				'x-webhook-timestamp': timestamp,
				'x-webhook-signature': sign({ secret, timestamp, body, path: '/api/webhook/alert' }),
			},
		};
		const next = jest.fn();
		validateWebhookSignature(req, response(), next);
		expect(next).toHaveBeenCalledTimes(1);

		const res = response();
		const next2 = jest.fn();
		validateWebhookSignature(req, res, next2);
		expect(next2).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(403);
		expect(res.json).toHaveBeenCalledWith({
			error: 'Forbidden: Webhook signature already used',
			code: 'WEBHOOK_SIGNATURE_REPLAY',
		});
	});

	it('verifies non-UTF-8 raw bodies without a UTF-8 round-trip', () => {
		const timestamp = String(Date.now());
		const rawBody = Buffer.from('{"text":"hola"}', 'utf16le');
		const canonicalPrefix = Buffer.from(`${timestamp}\nPOST\n/api/webhook/alert\n`, 'utf8');
		const signature = `sha256=${crypto.createHmac('sha256', secret)
			.update(Buffer.concat([canonicalPrefix, rawBody]))
			.digest('hex')}`;
		const next = jest.fn();

		validateWebhookSignature({
			method: 'POST',
			originalUrl: '/api/webhook/alert',
			rawBody,
			headers: { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature },
		}, response(), next);

		expect(next).toHaveBeenCalledTimes(1);
	});

	it('rejects compressed bodies with 400 WEBHOOK_SIGNATURE_COMPRESSED_BODY', () => {
		const timestamp = String(Date.now());
		const res = response();
		const next = jest.fn();

		validateWebhookSignature({
			method: 'POST',
			originalUrl: '/api/webhook/alert',
			rawBody: Buffer.from('{}'),
			headers: {
				'x-webhook-timestamp': timestamp,
				'x-webhook-signature': sign({ secret, timestamp, body: '{}', path: '/api/webhook/alert' }),
				'content-encoding': 'gzip',
			},
		}, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({
			error: 'Bad Request: Compressed webhook bodies are not supported with signing',
			code: 'WEBHOOK_SIGNATURE_COMPRESSED_BODY',
		});
	});

	it('retains a future-dated signature through its own validity window', () => {
		const timestamp = String(Date.now() + 200000);
		const body = '{"text":"future"}';
		const req = {
			method: 'POST',
			originalUrl: '/api/webhook/alert',
			rawBody: Buffer.from(body),
			headers: {
				'x-webhook-timestamp': timestamp,
				'x-webhook-signature': sign({ secret, timestamp, body, path: '/api/webhook/alert' }),
			},
		};
		const next = jest.fn();
		validateWebhookSignature(req, response(), next);
		expect(next).toHaveBeenCalledTimes(1);

		// Simulate time passing beyond first-receipt + tolerance but still
		// inside the signature's own window: the replay must still be caught.
		const realNow = Date.now;
		Date.now = () => Number(timestamp) + 100000;
		try {
			const res = response();
			const next2 = jest.fn();
			validateWebhookSignature(req, res, next2);
			expect(next2).not.toHaveBeenCalled();
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'WEBHOOK_SIGNATURE_REPLAY' }));
		} finally {
			Date.now = realNow;
		}
	});

	it('skips signature verification when the secret is unset', () => {
		delete process.env.WEBHOOK_SIGNING_SECRET;
		const next = jest.fn();

		validateWebhookSignature({ headers: {} }, response(), next);

		expect(next).toHaveBeenCalledTimes(1);
	});
});
