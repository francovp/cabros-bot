'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_PATH = path.join(
	__dirname,
	'../../.agents/skills/cabros-skill-optimizer/scripts/test-skills-e2e.sh',
);

function runValidation(args = [], envOverrides = {}) {
	return spawnSync('bash', [SCRIPT_PATH, ...args], {
		env: { ...process.env, ...envOverrides },
		encoding: 'utf8',
	});
}

describe('test-skills-e2e.sh test runner (#1220)', () => {
	it('script exists and is executable', () => {
		expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
		expect(() => fs.accessSync(SCRIPT_PATH, fs.constants.X_OK)).not.toThrow();
	});

	it('passes --all on repository .agents/skills directory with zero errors in under 5 seconds', () => {
		const start = Date.now();
		const result = runValidation(['--all']);
		const elapsed = Date.now() - start;

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('PASS');
		expect(result.stdout).toContain('All skill validations passed');
		expect(elapsed).toBeLessThan(5000);
	});

	it('supports running specific tiers via --tier', () => {
		const t1 = runValidation(['--tier', '1']);
		expect(t1.status).toBe(0);
		expect(t1.stdout).toContain('Tier 1');

		const t2 = runValidation(['--tier', '2']);
		expect(t2.status).toBe(0);
		expect(t2.stdout).toContain('Tier 2');

		const t3 = runValidation(['--tier', '3']);
		expect(t3.status).toBe(0);
		expect(t3.stdout).toContain('Tier 3');

		const t4 = runValidation(['--tier', '4']);
		expect(t4.status).toBe(0);
		expect(t4.stdout).toContain('Tier 4');
	});

	it('supports validating a single skill via --skill', () => {
		const result = runValidation(['--skill', 'cabros-skill-optimizer']);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('cabros-skill-optimizer');
	});

	describe('Failure detection on fixture trees', () => {
		let tempDir;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-fixture-'));
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		function createSkill(name, skillMdContent, scripts = {}) {
			const skillDir = path.join(tempDir, name);
			fs.mkdirSync(skillDir, { recursive: true });
			if (skillMdContent !== null) {
				fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent, 'utf8');
			}
			if (Object.keys(scripts).length > 0) {
				const scriptsDir = path.join(skillDir, 'scripts');
				fs.mkdirSync(scriptsDir, { recursive: true });
				for (const [scriptName, { content, mode }] of Object.entries(scripts)) {
					const scriptPath = path.join(scriptsDir, scriptName);
					fs.writeFileSync(scriptPath, content, 'utf8');
					if (mode) {
						fs.chmodSync(scriptPath, mode);
					}
				}
			}
		}

		it('Tier 1: fails when SKILL.md is missing', () => {
			createSkill('missing-md', null);

			const result = runValidation(['--skills-dir', tempDir, '--all']);
			expect(result.status).toBe(1);
			expect(result.stderr + result.stdout).toMatch(/SKILL\.md missing/i);
		});

		it('Tier 1: fails when frontmatter is malformed or unclosed', () => {
			createSkill('malformed-frontmatter', 'name: malformed\nno closing dashes\n# Title');

			const result = runValidation(['--skills-dir', tempDir, '--all']);
			expect(result.status).toBe(1);
			expect(result.stderr + result.stdout).toMatch(/frontmatter/i);
		});

		it('Tier 1: fails when frontmatter name does not match directory name', () => {
			createSkill('correct-name', '---\nname: wrong-name\ndescription: A test skill\n---\n# Title');

			const result = runValidation(['--skills-dir', tempDir, '--all']);
			expect(result.status).toBe(1);
			expect(result.stderr + result.stdout).toMatch(/name mismatch/i);
		});

		it('Tier 1: fails when frontmatter description is missing or empty', () => {
			createSkill('no-desc', '---\nname: no-desc\n---\n# Title');

			const result = runValidation(['--skills-dir', tempDir, '--all']);
			expect(result.status).toBe(1);
			expect(result.stderr + result.stdout).toMatch(/description/i);
		});

		it('Tier 2: fails when SKILL.md exceeds 500 lines', () => {
			const longContent = '---\nname: bloated-skill\ndescription: Too long\n---\n' +
				Array(505).fill('Line content here.').join('\n');
			createSkill('bloated-skill', longContent);

			const result = runValidation(['--skills-dir', tempDir, '--all']);
			expect(result.status).toBe(1);
			expect(result.stderr + result.stdout).toMatch(/500.*lines/i);
		});

		it('Tier 3: fails when a shell script has invalid bash syntax', () => {
			createSkill(
				'syntax-error-skill',
				'---\nname: syntax-error-skill\ndescription: A test skill\n---\n# Content',
				{ 'broken.sh': { content: 'if [[ foo; then\necho unclosed\n', mode: 0o755 } },
			);

			const result = runValidation(['--skills-dir', tempDir, '--all']);
			expect(result.status).toBe(1);
			expect(result.stderr + result.stdout).toMatch(/syntax error|bash -n failed/i);
		});

		it('Tier 3: fails when a shell script lacks executable permissions', () => {
			createSkill(
				'non-executable-skill',
				'---\nname: non-executable-skill\ndescription: A test skill\n---\n# Content',
				{ 'not-executable.sh': { content: '#!/bin/bash\necho "hello"\n', mode: 0o644 } },
			);

			const result = runValidation(['--skills-dir', tempDir, '--all']);
			expect(result.status).toBe(1);
			expect(result.stderr + result.stdout).toMatch(/not executable/i);
		});

		it('Tier 1: parses CRLF Windows line endings seamlessly', () => {
			createSkill('crlf-skill', '---\r\nname: crlf-skill\r\ndescription: A CRLF skill\r\n---\r\n# Title\r\nContent here.\r\n');

			const result = runValidation(['--skills-dir', tempDir, '--tier', '1']);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('PASS');
		});

		it('Tier 1: parses single-quoted name in frontmatter', () => {
			createSkill('quoted-skill', "---\nname: 'quoted-skill'\ndescription: Quoted name\n---\n# Title\nContent here.\n");

			const result = runValidation(['--skills-dir', `${tempDir}/`, '--tier', '1']);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('PASS');
		});

		it('Tier 2: fails when SKILL.md is missing in standalone tier 2 run', () => {
			createSkill('missing-for-tier2', null);

			const result = runValidation(['--skills-dir', tempDir, '--tier', '2']);
			expect(result.status).toBe(1);
			expect(result.stderr + result.stdout).toMatch(/SKILL\.md missing/i);
		});

		it('Tier 4: fails when a raw secret or API key pattern is found in files', () => {
			const dummyGhpToken = ['ghp', '123456789012345678901234567890123456'].join('_');
			createSkill(
				'secret-leak-skill',
				`---\nname: secret-leak-skill\ndescription: Leaks a key\n---\n# Content\n${dummyGhpToken}`,
			);

			const result = runValidation(['--skills-dir', tempDir, '--all']);
			expect(result.status).toBe(1);
			expect(result.stderr + result.stdout).toMatch(/secret|key pattern/i);
		});

		it('Tier 4: detects modern OpenAI project API keys (sk-proj-...)', () => {
			const dummyOpenAiKey = ['sk-proj', 'abcde123456789012345678901234567890'].join('-');
			createSkill(
				'openai-leak-skill',
				`---\nname: openai-leak-skill\ndescription: Leaks openai\n---\n# Content\n${dummyOpenAiKey}`,
			);

			const result = runValidation(['--skills-dir', tempDir, '--tier', '4']);
			expect(result.status).toBe(1);
			expect(result.stderr + result.stdout).toMatch(/secret|key pattern/i);
		});
	});
});
