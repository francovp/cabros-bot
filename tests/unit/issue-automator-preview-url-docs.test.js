/**
 * Documentation/script contract test for issue #1131 — "Align preview
 * verification docs with dynamic deployment URLs".
 *
 * The resolver (`get-pr-deployment-url.sh`) already returns the live preview
 * host from the GitHub Deployments API, with the Railway host pattern only as a
 * fallback. The verification contract around it still told agents to verify and
 * report the hardcoded Railway preview host, so a PR deployed to OpenClaw /
 * Tailscale / Fly.io (or any other provider) produced contradictory merge and
 * reporting instructions and could verify or reject the wrong target.
 *
 * This test pins the contract so the prose cannot silently drift back:
 *   1. the resolver script still resolves dynamically and documents the
 *      Railway fallback plus the fixed production endpoint;
 *   2. verify-preview.sh delegates URL resolution to the resolver and treats
 *      the SHA source and stale-deploy verdict as provider-neutral;
 *   3. every issue-automator surface that instructs preview verification
 *      points at the resolver instead of a hardcoded PR preview host;
 *   4. the readiness gate, the Step 7 report, the outcome contract and the
 *      stale-deploy recovery describe the same dynamic flow.
 *
 * Read-only: the suite never writes into the working tree.
 */

const { readFileSync, existsSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

const SKILL_DIR = join(__dirname, '../../.agents/skills/issue-automator');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const READINESS_MD = join(SKILL_DIR, 'references/readiness-and-verification.md');
const OUTCOMES_MD = join(SKILL_DIR, 'references/outcomes-and-deadlocks.md');
const RESOLVER_SH = join(SKILL_DIR, 'scripts/get-pr-deployment-url.sh');
const VERIFY_SH = join(SKILL_DIR, 'scripts/verify-preview.sh');

// The hardcoded Railway PR-preview host template. It may only ever appear as a
// documented *fallback*, never as the verification target.
const RAILWAY_PR_HOST = /cabros-bot-cabros-bot-pr-<\s*PR(_NUMBER)?\s*>/i;
const RAILWAY_PR_HOST_LITERAL = /cabros-bot-cabros-bot-pr-<\d+>/i;
// "fall back", "falls back" and "fell back" all label the host as a fallback.
const HOST_IS_FALLBACK = /\bfall(?:s|ed)?\s*back\b/i;

function read(path) {
	return readFileSync(path, 'utf8');
}

/** Section of a markdown file, from a heading up to the next same-level heading. */
function section(content, heading) {
	const start = content.indexOf(heading);
	if (start === -1) {
		throw new Error(`Section not found: ${heading}`);
	}
	const rest = content.slice(start + heading.length);
	const next = rest.search(/\n#{1,3} /);
	return next === -1 ? content.slice(start) : content.slice(start, start + heading.length + next);
}

/**
 * Lines that still present the hardcoded Railway PR-preview host as the
 * verification target. A line is only acceptable when it explicitly labels the
 * host as the fallback of the dynamic resolver.
 */
function hardcodedHostLines(text) {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && RAILWAY_PR_HOST.test(line))
		.filter((line) => !HOST_IS_FALLBACK.test(line));
}

describe('issue-automator deployment URL resolver (issue #1131)', () => {
	it('get-pr-deployment-url.sh resolves the live URL from the GitHub Deployments API', () => {
		expect(existsSync(RESOLVER_SH)).toBe(true);
		const script = read(RESOLVER_SH);

		// Dynamic resolution: environment-name probe, then ref probe.
		expect(script).toContain('resolve_from_environment');
		expect(script).toContain('resolve_from_ref');
		expect(script).toContain('/deployments?environment=');
		expect(script).toContain('/deployments?ref=');
		expect(script).toContain('environment_url');

		// Only a success/active deployment status is accepted.
		expect(script).toContain('[ "$state" = "success" ] || [ "$state" = "active" ]');

		// Railway is only the fallback, and the fallback is announced.
		expect(script).toMatch(/Falls? back to the Railway URL pattern/i);
		expect(script).toContain('Falling back to Railway URL');

		// Production is a fixed endpoint, resolved from an explicit alias. The
		// default must be the live host: the retired Railway origin answers 404, so
		// leaving it here made every production verification target a dead host.
		expect(script).toContain('cabros-crypto-bot-telegram.onrender.com');
		expect(script).not.toContain('cabros-bot-production.up.railway.app');
		expect(script).toContain('PRODUCTION_URL');
		expect(script).toMatch(/\[ "\$PR_NUMBER" = "production" \] \|\| \[ "\$PR_NUMBER" = "prod" \]/);
	});

	it('verify-preview.sh delegates URL resolution to the resolver', () => {
		expect(existsSync(VERIFY_SH)).toBe(true);
		const script = read(VERIFY_SH);

		expect(script).toContain('get-pr-deployment-url.sh');
		expect(script).toMatch(/get-pr-deployment-url\.sh"\s+"\$\{?PR_NUMBER/);

		// EXPECTED_SHA staleness contract: third positional argument, exit 2.
		expect(script).toContain('EXPECTED_SHA');
		expect(script).toContain('headRefOid');
		expect(script).toContain('exit 2');
	});

	it('verify-preview.sh reports a stale deploy without assuming Railway hosted it', () => {
		const script = read(VERIFY_SH);

		// The SHA mismatch verdict is emitted for any provider, so it must not
		// claim the deployment was Railway's.
		const staleLines = script
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => /not serving the PR head commit/i.test(line));

		expect(staleLines.length).toBeGreaterThan(0);
		for (const line of staleLines) {
			expect(line).not.toMatch(/Railway/i);
		}
	});

	it('both scripts pass bash syntax validation', () => {
		for (const script of [RESOLVER_SH, VERIFY_SH]) {
			const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
			expect(result.status).toBe(0);
			expect(result.stderr).toBe('');
		}
	});
});

describe('issue-automator preview verification docs resolve URLs dynamically (#1131)', () => {
	it('SKILL.md Deployment & Preview documents dynamic resolution, fallback and production', () => {
		const deploymentSection = section(read(SKILL_MD), '## Deployment & Preview');

		expect(deploymentSection).toContain('get-pr-deployment-url.sh <PR_NUMBER>');
		expect(deploymentSection).toContain('verify-preview.sh');
		expect(deploymentSection).toContain('EXPECTED_SHA');

		// The Railway host is documented as a fallback, not as the scheme.
		expect(deploymentSection).toMatch(/falls? back to the Railway pattern/i);
		expect(hardcodedHostLines(deploymentSection)).toEqual([]);
	});

	it('readiness-and-verification.md resolves the preview URL instead of pinning Railway', () => {
		const readiness = read(READINESS_MD);
		const previewSection = section(readiness, '## Preview and E2E');

		expect(previewSection).toContain('get-pr-deployment-url.sh');
		expect(previewSection).toContain('verify-preview.sh');

		// Railway survives only as the documented preview fallback; the production
		// host it used to name is retired and answers 404.
		expect(previewSection).toMatch(HOST_IS_FALLBACK);
		expect(previewSection).toContain('cabros-crypto-bot-telegram.onrender.com');
		expect(previewSection).not.toContain('cabros-bot-production.up.railway.app');
		expect(hardcodedHostLines(previewSection)).toEqual([]);
	});

	it('readiness merge gate does not make Railway a merge precondition', () => {
		const mergeGate = section(read(READINESS_MD), '## Merge Gate');

		// "Preview Live" and "Direct Verification" must be provider-neutral.
		const gateLines = mergeGate
			.split('\n')
			.filter((line) => /preview|verification/i.test(line));
		expect(gateLines.length).toBeGreaterThan(0);
		for (const line of gateLines) {
			expect(line).not.toMatch(/Railway/i);
		}
	});

	it('no issue-automator surface instructs verifying a hardcoded Railway PR host', () => {
		const offenders = [];
		for (const path of [SKILL_MD, READINESS_MD, OUTCOMES_MD]) {
			const lines = read(path)
				.split('\n')
				.map((line, index) => ({ line: line.trim(), number: index + 1 }))
				.filter((entry) => RAILWAY_PR_HOST.test(entry.line));
			for (const entry of lines) {
				// A mention is acceptable only when it explicitly labels the
				// host as the fallback of the dynamic resolver.
				if (!HOST_IS_FALLBACK.test(entry.line)) {
					offenders.push(`${path}:${entry.number}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	it('SKILL.md stale-deploy recovery re-resolves the URL instead of curling a fixed host', () => {
		const skill = read(SKILL_MD);
		const staleLine = skill
			.split('\n')
			.find((line) => /deployed commit visible via/i.test(line));

		expect(staleLine).toBeDefined();
		expect(staleLine).toContain('get-pr-deployment-url.sh');
		expect(RAILWAY_PR_HOST_LITERAL.test(staleLine)).toBe(false);
	});

	it('SKILL.md reports the resolved preview URLs, not Railway-only URLs', () => {
		const skill = read(SKILL_MD);
		const reportLines = skill
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => /^(\d+\.\s*)?(Performed verification steps|Performed verification)/i.test(line));

		expect(reportLines.length).toBeGreaterThan(0);
		for (const line of reportLines) {
			expect(line).toMatch(/URLs? verified/i);
			expect(line).not.toMatch(/Note the Railway URLs/i);
			expect(line).toContain('get-pr-deployment-url.sh');
		}
	});

	it('SKILL.md post-merge production verification is provider-neutral', () => {
		const mergeLines = read(SKILL_MD)
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => /verify (the )?production/i.test(line));

		expect(mergeLines.length).toBeGreaterThan(0);
		for (const line of mergeLines) {
			expect(line).toContain('verify-preview.sh production');
			expect(line).not.toMatch(/Railway/i);
		}
	});

	it('outcome contract recovery health check is described as dynamically resolved', () => {
		const recovery = read(OUTCOMES_MD)
			.split('\n')
			.map((line) => line.trim())
			.find((line) => /stale-deploy \/ bounded-retry recovery/i.test(line));

		expect(recovery).toBeDefined();
		expect(recovery).toContain('verify-preview.sh');
		expect(recovery).toMatch(/resolve/i);
	});
});