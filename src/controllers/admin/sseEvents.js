'use strict';

const { adminSseService } = require('../../services/sse/AdminSseService');

function getAdminKey(req) {
	const user = req.adminUser || req.user;
	if (user && (user.uid || user.email)) {
		return `user:${user.uid || user.email}`;
	}
	const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
	const apiKey = req.headers['x-api-key'] || req.query?.['api-key'];
	if (apiKey) {
		return `key:${apiKey}`;
	}
	return `ip:${ip}`;
}

async function handleSseStream(req, res) {
	const clientKey = getAdminKey(req);
	const result = adminSseService.addClient(req, res, clientKey);

	if (!result.ok) {
		if (result.status === 503) {
			res.setHeader('Retry-After', '30');
		}
		return res.status(result.status).json({
			error: result.message,
			code: result.code,
		});
	}
}

module.exports = {
	handleSseStream,
	getAdminKey,
};
