/**
 * Issue #1230 follow-up: Brave results must carry a DOMAIN in `sourceDomain`.
 *
 * Brave returns `profile.name` as a human-readable label ("Reuters", "Medium").
 * `domainQuality` classifies on domain strings, so passing the display name
 * through made essentially every Brave-sourced result classify as `unknown`,
 * silently disabling the quality penalty precisely when Brave was the active
 * provider (Gemini fallback path, or FORCE_BRAVE_SEARCH).
 */
// The key/endpoint are read at MODULE LOAD, so they must be set before the
// require — setting them in beforeEach is too late and yields empty results.
process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
process.env.BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const { GenaiClient } = require('../../src/services/grounding/genaiClient');

function mockBrave(payload) {
	global.fetch = jest.fn().mockResolvedValue({
		ok: true,
		json: async () => payload,
	});
}

describe('Brave search sourceDomain derivation (issue #1230)', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	it('derives sourceDomain from the result URL, not the Brave display name', async () => {
		mockBrave({
			web: {
				results: [
					{ title: 'Markets', url: 'https://www.reuters.com/markets/a', description: 'd', profile: { name: 'Reuters' } },
					{ title: 'Opinion', url: 'https://medium.com/@x/a', description: 'd', profile: { name: 'Medium' } },
				],
			},
		});

		const results = await new GenaiClient()._searchBrave('crypto market');
		const domains = results.map(r => r.sourceDomain);

		expect(domains).toEqual(['www.reuters.com', 'medium.com']);
		expect(domains).not.toContain('Reuters');
		expect(domains).not.toContain('Medium');
	});

	it('yields an empty sourceDomain rather than a display name when the URL is unusable', async () => {
		mockBrave({
			web: { results: [{ title: 't', url: 'not a url', profile: { name: 'Reuters' } }] },
		});

		const results = await new GenaiClient()._searchBrave('crypto market');
		expect(results[0].sourceDomain).toBe('');
	});

	it('classifies Brave-sourced domains correctly instead of collapsing them to unknown', () => {
		const domainQuality = require('../../src/services/grounding/domainQuality');

		const reuters = domainQuality.scoreQuality([{ url: 'https://www.reuters.com/a', sourceDomain: 'www.reuters.com' }]);
		expect(reuters.tierCounts.high).toBe(1);

		const medium = domainQuality.scoreQuality([{ url: 'https://medium.com/a', sourceDomain: 'medium.com' }]);
		expect(medium.tierCounts.low).toBe(1);
	});
});
