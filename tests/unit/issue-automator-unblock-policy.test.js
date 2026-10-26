'use strict';

/**
 * Contract test for issue-automator unblock policy:
 * "Improve /issue-automator skill to reduce GLOBAL_BLOCKED and NEEDS_USER states".
 *
 * Verifies that:
 * 1. SKILL.md defines "Progress Without False Blockers" with explicit fallbacks for:
 *    - Resolvable NEEDS_USER issues (decide recommended reversible solution and continue)
 *    - Failed notifications (do not block underlying work or relabel GLOBAL_BLOCKED)
 *    - Claim helper failures (continue in verified unclaimed mode without claiming)
 *    - Preview-only verification failures (merge as unverified when CI, local tests, and reviews pass)
 * 2. references/progress-and-blocker-policy.md exists and contains the decision matrix and proof requirements.
 * 3. references/outcomes-and-deadlocks.md and references/readiness-and-verification.md match the unblock semantics.
 * 4. SKILL.md complies with the 500-line limit enforced by test-skills-e2e.sh.
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

const SKILL_DIR = join(__dirname, '../../.agents/skills/issue-automator');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const POLICY_MD = join(SKILL_DIR, 'references/progress-and-blocker-policy.md');
const OUTCOMES_MD = join(SKILL_DIR, 'references/outcomes-and-deadlocks.md');
const READINESS_MD = join(SKILL_DIR, 'references/readiness-and-verification.md');

function read(filePath) {
	return readFileSync(filePath, 'utf8');
}

describe('issue-automator unblock policy and contract invariants', () => {
	it('SKILL.md exists and is within the 500-line budget', () => {
		expect(existsSync(SKILL_MD)).toBe(true);
		const content = read(SKILL_MD);
		const lineCount = content.split('\n').length;
		expect(lineCount).toBeLessThanOrEqual(500);
	});

	it('progress-and-blocker-policy.md reference exists and defines the decision matrix', () => {
		expect(existsSync(POLICY_MD)).toBe(true);
		const policy = read(POLICY_MD);
		expect(policy).toContain('# Progress and Blocker Decision Policy');
		expect(policy).toContain('WhatsApp');
		expect(policy).toContain('NEEDS_USER');
		expect(policy).toContain('unclaimed');
		expect(policy).toContain('unverified');
	});

	it('SKILL.md contains "Progress Without False Blockers" section with required fallbacks', () => {
		const skill = read(SKILL_MD);
		expect(skill).toContain('## Progress Without False Blockers');

		// 1. NEEDS_USER fallback
		expect(skill).toMatch(/NEEDS_USER[\s\S]*?operator authorizes the agent to recommend and choose/i);
		expect(skill).toMatch(/failed WhatsApp attempt never creates or prolongs `?NEEDS_USER`?/i);

		// 2. Notification failure fallback
		expect(skill).toMatch(/Notification failure/i);
		expect(skill).toMatch(/Do not .* relabel the item `?GLOBAL_BLOCKED`? solely because notification failed/i);

		// 3. Claim failure fallback (unclaimed mode)
		expect(skill).toMatch(/Claim helper failure/i);
		expect(skill).toMatch(/continue in \*\*unclaimed mode\*\*/i);

		// 4. Preview-only failure fallback
		expect(skill).toMatch(/Preview-only failure/i);
		expect(skill).toMatch(/treat unavailable or unhealthy preview as `?unverified`? and continue to merge/i);
	});

	it('references/outcomes-and-deadlocks.md reflects unblock fallbacks', () => {
		const outcomes = read(OUTCOMES_MD);
		expect(outcomes).toContain('Progress Without False Blockers');
		expect(outcomes).toMatch(/Notification delivery and isolated preview failure do not qualify/i);
	});

	it('references/readiness-and-verification.md reflects preview-only unverified merge exception', () => {
		const readiness = read(READINESS_MD);
		expect(readiness).toMatch(/apply the preview-only exception in SKILL\.md and record `?unverified`?/i);
	});
});
