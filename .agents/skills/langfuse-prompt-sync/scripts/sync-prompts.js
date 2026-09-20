#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DEFAULTS_DIR = path.join(REPO_ROOT, 'src/services/prompts/defaults');

function parseArgs() {
	const args = process.argv.slice(2);
	const parsed = {
		dryRun: false,
		promptName: null,
		envFile: null,
		labels: ['production', 'latest'],
		commitMessage: 'Sync prompt from codebase defaults',
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--dry-run') {
			parsed.dryRun = true;
		} else if (arg === '--prompt' && i + 1 < args.length) {
			parsed.promptName = args[++i];
		} else if (arg === '--env' && i + 1 < args.length) {
			parsed.envFile = args[++i];
		} else if (arg === '--message' && i + 1 < args.length) {
			parsed.commitMessage = args[++i];
		} else if (arg === '--labels' && i + 1 < args.length) {
			parsed.labels = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
		}
	}

	return parsed;
}

function resolveEnvFile(explicitEnvFile) {
	if (explicitEnvFile && fs.existsSync(explicitEnvFile)) {
		return explicitEnvFile;
	}

	const userHome = process.env.HOME || process.env.USERPROFILE || '';
	const userConfigEnv = path.join(userHome, '.config', 'langfuse-cli', '.env');
	if (fs.existsSync(userConfigEnv)) {
		return userConfigEnv;
	}

	const repoEnv = path.join(REPO_ROOT, '.env');
	if (fs.existsSync(repoEnv)) {
		return repoEnv;
	}

	return null;
}

function discoverLocalPrompts() {
	if (!fs.existsSync(DEFAULTS_DIR)) {
		throw new Error(`Defaults directory not found: ${DEFAULTS_DIR}`);
	}

	const files = fs.readdirSync(DEFAULTS_DIR);
	const promptsMap = new Map();

	for (const file of files) {
		if (file.endsWith('.system.txt')) {
			const name = file.replace(/\.system\.txt$/, '');
			const current = promptsMap.get(name) || { name, type: 'chat' };
			current.system = fs.readFileSync(path.join(DEFAULTS_DIR, file), 'utf8').replace(/\r\n/g, '\n').trim();
			promptsMap.set(name, current);
		} else if (file.endsWith('.user.txt')) {
			const name = file.replace(/\.user\.txt$/, '');
			const current = promptsMap.get(name) || { name, type: 'chat' };
			current.user = fs.readFileSync(path.join(DEFAULTS_DIR, file), 'utf8').replace(/\r\n/g, '\n').trim();
			promptsMap.set(name, current);
		} else if (file.endsWith('.txt') && !file.endsWith('.system.txt') && !file.endsWith('.user.txt') && file !== 'README.md') {
			const name = file.replace(/\.txt$/, '');
			const current = promptsMap.get(name) || { name, type: 'text' };
			current.text = fs.readFileSync(path.join(DEFAULTS_DIR, file), 'utf8').replace(/\r\n/g, '\n').trim();
			promptsMap.set(name, current);
		}
	}

	return Array.from(promptsMap.values()).map((item) => {
		if (item.type === 'chat') {
			return {
				name: item.name,
				type: 'chat',
				prompt: [
					...(item.system ? [{ role: 'system', content: item.system }] : []),
					...(item.user ? [{ role: 'user', content: item.user }] : []),
				],
			};
		}
		return {
			name: item.name,
			type: 'text',
			prompt: item.text || '',
		};
	});
}

function runLangfuseCommand(cmd, envFile) {
	const envArg = envFile ? `--env "${envFile}"` : '';
	// Use `langfuse` directly — globally installed in CI (`npm install -g langfuse-cli`),
	// resolved via PATH locally (npx langfuse or global install).
	const fullCmd = `langfuse ${envArg} ${cmd}`;
	try {
		const stdout = execSync(fullCmd, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return { success: true, output: stdout.trim() };
	} catch (error) {
		return {
			success: false,
			error: error.stderr ? error.stderr.trim() : error.message,
			output: error.stdout ? error.stdout.trim() : '',
			code: error.status,
		};
	}
}

async function main() {
	const args = parseArgs();
	const envFile = resolveEnvFile(args.envFile);

	console.log(`[langfuse-prompt-sync] Using env file: ${envFile || '(process.env)'}`);
	if (args.dryRun) {
		console.log('[langfuse-prompt-sync] Running in DRY RUN mode (no changes will be applied)');
	}

	const localPrompts = discoverLocalPrompts();
	const targets = args.promptName
		? localPrompts.filter((p) => p.name === args.promptName)
		: localPrompts;

	if (targets.length === 0) {
		console.error(`[langfuse-prompt-sync] No local prompt definitions found${args.promptName ? ` matching "${args.promptName}"` : ''}.`);
		process.exit(1);
	}

	console.log(`[langfuse-prompt-sync] Processing ${targets.length} prompt(s)...`);

	let successCount = 0;
	let skipCount = 0;
	let errorCount = 0;

	for (const promptDef of targets) {
		console.log(`\n--- Prompt: ${promptDef.name} (${promptDef.type}) ---`);

		// Check remote prompt
		const remoteCheck = runLangfuseCommand(`api prompts get ${promptDef.name} --label latest`, envFile);
		let remotePromptObj = null;

		if (remoteCheck.success) {
			try {
				remotePromptObj = JSON.parse(remoteCheck.output);
				console.log(`[Remote] Found version ${remotePromptObj.version} with labels: ${JSON.stringify(remotePromptObj.labels)}`);
			} catch (_) {
				// unparseable response
			}
		} else {
			console.log(`[Remote] Prompt "${promptDef.name}" not found or not yet created.`);
		}

		// Compare content
		let isIdentical = false;
		if (remotePromptObj && remotePromptObj.prompt) {
			if (promptDef.type === 'chat' && Array.isArray(remotePromptObj.prompt)) {
				const remoteSystem = remotePromptObj.prompt.find((m) => m.role === 'system')?.content?.trim() || '';
				const remoteUser = remotePromptObj.prompt.find((m) => m.role === 'user')?.content?.trim() || '';
				const localSystem = promptDef.prompt.find((m) => m.role === 'system')?.content?.trim() || '';
				const localUser = promptDef.prompt.find((m) => m.role === 'user')?.content?.trim() || '';
				isIdentical = remoteSystem === localSystem && remoteUser === localUser;
			} else if (promptDef.type === 'text' && typeof remotePromptObj.prompt === 'string') {
				isIdentical = remotePromptObj.prompt.trim() === promptDef.prompt.trim();
			}
		}

		if (isIdentical) {
			console.log(`[Status] In sync with remote version ${remotePromptObj.version}. Skipping.`);
			skipCount++;
			continue;
		}

		console.log(`[Status] Updates detected. New version required.`);

		const createPayload = {
			name: promptDef.name,
			type: promptDef.type,
			prompt: promptDef.prompt,
			labels: args.labels,
			commitMessage: args.commitMessage,
		};

		if (args.dryRun) {
			console.log('[Dry Run Payload]:');
			console.log(JSON.stringify(createPayload, null, 2));
			successCount++;
			continue;
		}

		const jsonString = JSON.stringify(createPayload);
		// Write temporary payload to avoid shell quoting issues
		const tmpFile = path.join(REPO_ROOT, `.tmp-prompt-${Date.now()}.json`);
		try {
			fs.writeFileSync(tmpFile, jsonString, 'utf8');
			const createResult = runLangfuseCommand(`api prompts create --body-file "${tmpFile}"`, envFile);
			if (createResult.success) {
				console.log(`[Success] Prompt "${promptDef.name}" updated successfully:`);
				try {
					const res = JSON.parse(createResult.output);
					console.log(`  New Version: ${res.version}`);
					console.log(`  Labels: ${JSON.stringify(res.labels)}`);
				} catch (_) {
					console.log(createResult.output);
				}
				successCount++;
			} else {
				console.error(`[Error] Failed to create prompt version: ${createResult.error || createResult.output}`);
				errorCount++;
			}
		} finally {
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	}

	console.log(`\n========================================`);
	console.log(`Sync complete: ${successCount} updated, ${skipCount} identical/skipped, ${errorCount} errors.`);
	if (errorCount > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`[langfuse-prompt-sync] Fatal error: ${err.message}`);
	process.exit(1);
});
