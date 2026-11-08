'use strict';

const dns = require('dns');
const net = require('net');
const { Agent } = require('undici');

const NON_RETRYABLE_CALLBACK_STATUSES = new Set([400, 401, 403, 404, 422]);

function expandIPv6(ip) {
	let fullIp = ip;
	if (ip.includes('::')) {
		const parts = ip.split('::');
		const left = parts[0] ? parts[0].split(':') : [];
		const right = parts[1] ? parts[1].split(':') : [];
		const missingCount = 8 - (left.length + right.length);
		const middle = Array(missingCount).fill('0');
		fullIp = [...left, ...middle, ...right].join(':');
	}
	return fullIp.split(':').map(part => part.padStart(4, '0')).join(':');
}

function isPrivateIp(ip) {
	if (!ip) return true;

	let cleanIp = ip.trim().toLowerCase();

	// Handle IPv4-mapped IPv6 address like ::ffff:192.168.1.1
	if (cleanIp.startsWith('::ffff:')) {
		const ipv4Candidate = ip.substring(7);
		if (net.isIPv4(ipv4Candidate)) {
			cleanIp = ipv4Candidate;
		}
	}

	if (net.isIPv4(cleanIp)) {
		const parts = cleanIp.split('.').map(Number);
		if (parts.length !== 4 || parts.some(isNaN)) return true;

		if (parts[0] === 0) return true; // Current network / software-only
		if (parts[0] === 127) return true; // Loopback
		if (parts[0] === 10) return true; // RFC1918
		if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // RFC1918
		if (parts[0] === 192 && parts[1] === 168) return true; // RFC1918
		if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true; // IETF special-purpose
		if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // RFC6598 shared address space
		if (parts[0] === 169 && parts[1] === 254) return true; // Link-local (includes 169.254.169.254)
		if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true; // Benchmarking
		if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true; // Documentation
		if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true; // Documentation
		if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true; // Documentation
		if (parts[0] >= 224 && parts[0] <= 239) return true; // Multicast
		if (parts[0] >= 240) return true; // Reserved / limited broadcast
		if (parts[0] === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255) return true;

		return false;
	}

	if (net.isIPv6(cleanIp)) {
		const expanded = expandIPv6(cleanIp);

		if (expanded === '0000:0000:0000:0000:0000:0000:0000:0001') return true; // Loopback
		if (expanded === '0000:0000:0000:0000:0000:0000:0000:0000') return true; // Unspecified
		if (/^fe[89ab]/i.test(expanded)) return true; // Link-local
		if (/^f[cd]/i.test(expanded)) return true; // ULA
		if (expanded.startsWith('ff')) return true; // Multicast

		// Hex IPv4-mapped IPv6 address: ::ffff:7f00:0001
		if (expanded.startsWith('0000:0000:0000:0000:0000:ffff:')) {
			const parts = expanded.split(':');
			const part6 = parts[6];
			const part7 = parts[7];

			const octet0 = parseInt(part6.substring(0, 2), 16);
			const octet1 = parseInt(part6.substring(2, 4), 16);
			const octet2 = parseInt(part7.substring(0, 2), 16);
			const octet3 = parseInt(part7.substring(2, 4), 16);

			const mappedIpv4 = `${octet0}.${octet1}.${octet2}.${octet3}`;
			return isPrivateIp(mappedIpv4);
		}

		return false;
	}

	return true;
}

function normalizeHostname(hostname) {
	if (hostname.startsWith('[') && hostname.endsWith(']')) {
		return hostname.slice(1, -1);
	}
	return hostname;
}

function sanitizeCallbackUrlForLog(urlStr) {
	try {
		const url = new URL(urlStr);
		url.username = '';
		url.password = '';
		url.pathname = '/...';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch (err) {
		return '[invalid callback URL]';
	}
}

async function validateCallbackUrl(urlStr) {
	try {
		const url = new URL(urlStr);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return { valid: false, reason: 'format' };
		}

		const hostname = normalizeHostname(url.hostname);

		if (url.protocol === 'http:') {
			const httpAllowed = hostname === 'localhost' ||
				hostname === '127.0.0.1' ||
				hostname === '::1' ||
				process.env.NODE_ENV === 'test' ||
				process.env.ALLOW_HTTP_CALLBACKS === 'true';
			if (!httpAllowed) {
				return { valid: false, reason: 'format' };
			}
		}

		const allowPrivate = process.env.ALLOW_PRIVATE_CALLBACKS === 'true' ||
			process.env.NODE_ENV === 'test';

		let addresses;
		if (net.isIP(hostname)) {
			addresses = [{ address: hostname, family: net.isIP(hostname) }];
		} else {
			try {
				addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
			} catch (dnsErr) {
				return { valid: false, reason: 'dns' };
			}
		}

		if (!addresses.length || (!allowPrivate && addresses.some(({ address }) => isPrivateIp(address)))) {
			return { valid: false, reason: 'private' };
		}

		return { valid: true, addresses };
	} catch (err) {
		return { valid: false, reason: 'format' };
	}
}

function createPinnedLookup(addresses) {
	const pinnedAddresses = addresses.map(({ address, family }) => ({
		address,
		family: family || net.isIP(address),
	}));

	return (hostname, options, callback) => {
		const requestedFamily = options?.family || 0;
		const matchingAddresses = pinnedAddresses.filter(({ family }) => !requestedFamily || family === requestedFamily);
		if (!matchingAddresses.length) {
			const error = new Error(`No validated DNS answer for ${hostname}`);
			error.code = 'ENOTFOUND';
			callback(error);
			return;
		}

		if (options?.all) {
			callback(null, matchingAddresses);
			return;
		}

		const [{ address, family }] = matchingAddresses;
		callback(null, address, family);
	};
}

function createPinnedCallbackDispatcher(addresses) {
	return new Agent({
		connect: {
			lookup: createPinnedLookup(addresses),
		},
	});
}

async function isValidCallbackUrl(urlStr) {
	const result = await validateCallbackUrl(urlStr);
	return result.valid;
}

module.exports = {
	expandIPv6,
	isPrivateIp,
	normalizeHostname,
	sanitizeCallbackUrlForLog,
	validateCallbackUrl,
	createPinnedLookup,
	createPinnedCallbackDispatcher,
	isValidCallbackUrl,
	NON_RETRYABLE_CALLBACK_STATUSES,
};
