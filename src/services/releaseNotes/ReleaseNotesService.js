'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VALID_TYPES = new Set([
	'feat',
	'fix',
	'perf',
	'chore',
	'docs',
	'refactor',
	'test',
	'build',
	'style',
	'ci',
	'revert',
	'other',
]);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

class ReleaseNotesService {
	constructor({ changelogPath, logger } = {}) {
		const filename =
			changelogPath || path.resolve(process.cwd(), 'changelog.json');
		this.changelogPath = filename;
		this.logger = logger || console;
		this._cached = null;
		this._cachedAt = 0;
		this._cacheTtlMs = 60 * 1000;
	}

	getChangelogPath() {
		return this.changelogPath;
	}

	clearCache() {
		this._cached = null;
		this._cachedAt = 0;
	}

	loadChangelog() {
		if (!fs.existsSync(this.changelogPath)) {
			return {
				version: '0.0.0',
				generatedAt: null,
				branch: 'master',
				sinceTag: null,
				sinceDate: null,
				entries: [],
				reason: 'changelog_not_generated',
			};
		}

		let raw;
		try {
			raw = fs.readFileSync(this.changelogPath, 'utf8');
		} catch (error) {
			this.logger.warn(
				`[release-notes] Failed to read changelog at ${this.changelogPath}: ${error.message}`,
			);
			return {
				version: '0.0.0',
				entries: [],
				reason: 'changelog_read_failed',
				error: error.message,
			};
		}

		try {
			const parsed = JSON.parse(raw);
			if (!parsed || !Array.isArray(parsed.entries)) {
				return {
					version: parsed && typeof parsed.version === 'string' ? parsed.version : '0.0.0',
					entries: [],
					reason: 'changelog_malformed',
				};
			}
			return {
				version: parsed.version || '0.0.0',
				generatedAt: parsed.generatedAt || null,
				branch: parsed.branch || 'master',
				sinceTag: parsed.sinceTag || null,
				sinceDate: parsed.sinceDate || null,
				entries: parsed.entries,
				reason: parsed.reason || null,
				error: parsed.error || null,
			};
		} catch (error) {
			this.logger.warn(
				`[release-notes] Failed to parse changelog JSON at ${this.changelogPath}: ${error.message}`,
			);
			return {
				version: '0.0.0',
				entries: [],
				reason: 'changelog_parse_failed',
				error: error.message,
			};
		}
	}

	loadChangelogCached({ forceReload = false } = {}) {
		const now = Date.now();
		if (
			!forceReload &&
			this._cached &&
			now - this._cachedAt < this._cacheTtlMs
		) {
			return this._cached;
		}
		this._cached = this.loadChangelog();
		this._cachedAt = now;
		return this._cached;
	}

	parseLimit(rawLimit) {
		if (rawLimit === undefined) return DEFAULT_LIMIT;
		const parsed = Number.parseInt(rawLimit, 10);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
			return null;
		}
		return parsed;
	}

	parseTypes(rawTypes) {
		if (rawTypes === undefined) return undefined;
		if (typeof rawTypes !== 'string') return null;
		const items = rawTypes
			.split(',')
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		if (items.length === 0) return undefined;
		const invalid = items.filter((t) => !VALID_TYPES.has(t));
		if (invalid.length > 0) {
			return { error: `Invalid changelog type(s): ${invalid.join(', ')}` };
		}
		return Array.from(new Set(items));
	}

	parseSince(rawSince) {
		if (rawSince === undefined) return undefined;
		if (typeof rawSince !== 'string' || !rawSince.trim()) {
			return { error: 'Invalid since date. Use an ISO-8601 timestamp or YYYY-MM-DD.' };
		}
		const ts = Date.parse(rawSince);
		if (Number.isNaN(ts)) {
			return { error: 'Invalid since date. Use an ISO-8601 timestamp or YYYY-MM-DD.' };
		}
		return new Date(ts).toISOString();
	}

	listEntries({ limit, types, since } = {}) {
		const changelog = this.loadChangelogCached();
		let entries = changelog.entries || [];

		if (Array.isArray(types) && types.length > 0) {
			const set = new Set(types);
			entries = entries.filter((entry) => set.has(entry.type));
		}

		if (since) {
			const sinceTs = Date.parse(since);
			if (!Number.isNaN(sinceTs)) {
				entries = entries.filter((entry) => {
					if (!entry.mergedAt) return false;
					const ts = Date.parse(entry.mergedAt);
					return !Number.isNaN(ts) && ts >= sinceTs;
				});
			}
		}

		entries = entries
			.slice()
			.sort((a, b) => {
				const aTs = a && a.mergedAt ? Date.parse(a.mergedAt) : 0;
				const bTs = b && b.mergedAt ? Date.parse(b.mergedAt) : 0;
				return bTs - aTs;
			})
			.slice(0, limit);

		return entries;
	}

	getVersion(version) {
		if (!version || typeof version !== 'string') return null;
		const changelog = this.loadChangelogCached();
		const entries = changelog.entries || [];
		if (changelog.version === version) {
			return {
				version: changelog.version,
				generatedAt: changelog.generatedAt,
				branch: changelog.branch,
				sinceTag: changelog.sinceTag,
				sinceDate: changelog.sinceDate,
				entries,
			};
		}
		if (Number.isNaN(Date.parse(version))) {
			return null;
		}
		const versionDate = Date.parse(version);
		const matching = entries.filter((entry) => {
			if (!entry.mergedAt) return false;
			const ts = Date.parse(entry.mergedAt);
			return !Number.isNaN(ts) && ts >= versionDate;
		});
		return {
			version,
			generatedAt: new Date(versionDate).toISOString(),
			branch: changelog.branch,
			sinceTag: changelog.sinceTag,
			sinceDate: changelog.sinceDate,
			entries: matching,
		};
	}

	getSummary({ limit, types, since } = {}) {
		const changelog = this.loadChangelogCached();
		const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
		const entries = this.listEntries({ limit: safeLimit, types, since });
		const counts = entries.reduce((acc, entry) => {
			acc[entry.type] = (acc[entry.type] || 0) + 1;
			return acc;
		}, {});
		const days = entries.reduce((acc, entry) => {
			if (!entry.mergedAt) return acc;
			const day = entry.mergedAt.slice(0, 10);
			acc[day] = (acc[day] || 0) + 1;
			return acc;
		}, {});
		return {
			version: changelog.version,
			generatedAt: changelog.generatedAt,
			branch: changelog.branch,
			sinceTag: changelog.sinceTag,
			sinceDate: changelog.sinceDate,
			reason: changelog.reason || null,
			total: entries.length,
			counts,
			days,
			entries,
		};
	}
}

module.exports = {
	ReleaseNotesService,
	DEFAULT_LIMIT,
	MAX_LIMIT,
	VALID_TYPES,
};

const defaultService = new ReleaseNotesService();
module.exports.releaseNotesService = defaultService;
