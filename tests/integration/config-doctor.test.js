const { spawn, spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');

describe('configuration doctor process', () => {
	it('exits zero and prints actionable warnings for broken configuration', () => {
		const env = { ...process.env };
		env.NODE_ENV = 'test';
		env.ENABLE_WHATSAPP_ALERTS = 'true';
		env.WHATSAPP_API_URL = 'https://api.green-api.com/waInstance/';
		env.WHATSAPP_CHAT_ID = '120363000000000000@g.us';
		delete env.WHATSAPP_API_KEY;

		const result = spawnSync(process.execPath, ['scripts/validate-env.js'], {
			cwd: repoRoot,
			env,
			encoding: 'utf8',
		});
		const output = `${result.stdout}${result.stderr}`;

		expect(result.status).toBe(0);
		expect(output).toContain('WHATSAPP_API_KEY');
		expect(output).toContain('.env.example');
	});

	it('logs startup warnings without preventing server boot or Telegram gating', async () => {
		const env = { ...process.env };
		Object.assign(env, {
			NODE_ENV: 'test',
			PORT: '0',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_TELEGRAM_BOT: 'false',
			ENABLE_WHATSAPP_ALERTS: 'true',
			WHATSAPP_API_URL: 'https://api.green-api.com/waInstance/',
			WHATSAPP_CHAT_ID: '120363000000000000@g.us',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_SENTRY: 'false',
			ENABLE_NEWS_MONITOR: 'false',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
			ENABLE_FIRESTORE_JOB_STORAGE: 'false',
			ENABLE_FIRESTORE_SCANNER_PRESETS: 'false',
			ENABLE_FIRESTORE_IDEMPOTENCY: 'false',
			ENABLE_FIREBASE_REMOTE_CONFIG: 'false',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'false',
			LOG_LEVEL: 'info',
		});
		delete env.WHATSAPP_API_KEY;

		const child = spawn(process.execPath, ['index.js'], {
			cwd: repoRoot,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		let stopped = false;
		const stop = () => {
			if (!stopped) {
				stopped = true;
				child.kill('SIGTERM');
			}
		};

		const result = await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				stop();
				reject(new Error(`startup validation timed out: ${output}`));
			}, 8000);
			const onData = (chunk) => {
				output += chunk.toString();
				if (output.includes('WHATSAPP_API_KEY') && output.includes('Telegram Bot is disabled')) stop();
			};
			child.stdout.on('data', onData);
			child.stderr.on('data', onData);
			child.once('error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once('close', (code, signal) => {
				clearTimeout(timeout);
				resolve({ code, signal });
			});
		});

		expect(output).toContain('WHATSAPP_API_KEY');
		expect(output).toContain('Configuration warning');
		expect(output).toContain('Telegram Bot is disabled');
		expect(result.signal === 'SIGTERM' || result.code === 0).toBe(true);
	});
});
