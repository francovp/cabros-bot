const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', '.github', 'workflows');
const PACKAGE_JSON_PATH = path.join(__dirname, '..', '..', 'package.json');

describe('CI pnpm version source alignment (GH-559)', () => {
	it('defines packageManager in package.json as the authoritative pnpm version', () => {
		const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
		expect(pkg.packageManager).toBeDefined();
		expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+/);
	});

	it('ensures no workflow references pnpm/action-setup@v3', () => {
		const files = fs.readdirSync(WORKFLOWS_DIR).filter(file => file.endsWith('.yml') || file.endsWith('.yaml'));
		for (const file of files) {
			const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
			expect(content).not.toContain('pnpm/action-setup@v3');
		}
	});

	it('ensures all workflows using pnpm/action-setup use the pinned v4 SHA and do not override version', () => {
		const files = fs.readdirSync(WORKFLOWS_DIR).filter(file => file.endsWith('.yml') || file.endsWith('.yaml'));
		const PINNED_ACTION_SETUP = 'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1';

		let checkedStepsCount = 0;
		for (const file of files) {
			const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
			// Match each step starting with '-' until the next step or unindented block/end
			const steps = content.match(/(?:^|\n)\s*-\s+[\s\S]*?(?=\n\s*-\s|\n\S|$)/g) || [];

			for (const step of steps) {
				if (!step.includes('pnpm/action-setup')) continue;
				checkedStepsCount++;

				// Every action-setup step must use the pinned SHA
				expect(step).toContain(PINNED_ACTION_SETUP);

				// Must not contain any version override (unquoted, quoted, or variable)
				expect(step).not.toMatch(/\bversion\s*:/);
			}
		}

		// Ensure all 8 action-setup steps across the workflows were verified
		expect(checkedStepsCount).toBe(8);
	});
});
