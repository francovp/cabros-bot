'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Issue #598 regression coverage for the publish side of the Firebase server
 * Remote Config template.
 *
 * The runtime loader (`admin.remoteConfig().initServerTemplate()`) reads the
 * `firebase-server` namespace. The bootstrap publish script must therefore
 * bootstrap that same namespace even when it has never been published before:
 * the pre-publish `getServerTemplate()` read 404s (`remote-config/not-found`)
 * when the namespace does not exist yet, which used to abort the publish before
 * any PUT was attempted. The template then never reached Firebase, so every
 * production load failed forever and the feature stayed inert.
 */

describe('Firebase server Remote Config publish script', () => {
	const rootDir = path.join(__dirname, '../..');
	const scriptPath = path.join(rootDir, 'scripts/deploy-server-remote-config.js');
	const workflowPath = path.join(rootDir, '.github/workflows/firebase-remote-config.yml');
	const templatePath = path.join(rootDir, 'firebase-remote-config-template.json');

	let script;
	let client;
	let remoteConfig;
	let originalEnv;

	function deps(overrides = {}) {
		return {
			client,
			remoteConfig,
			app: { options: { projectId: 'cabros-bot' } },
			...overrides,
		};
	}

	beforeEach(() => {
		originalEnv = { ...process.env };
		process.env.FIREBASE_PROJECT_ID = 'cabros-bot';

		client = { send: jest.fn() };
		remoteConfig = { getServerTemplate: jest.fn() };

		jest.resetModules();
		script = require(scriptPath);
	});

	afterEach(() => {
		Object.keys(process.env).forEach((key) => delete process.env[key]);
		Object.assign(process.env, originalEnv);
	});

	function okResponse() {
		return { status: 200, headers: { etag: 'etag-after-publish' }, data: {} };
	}

	function notFoundError() {
		const error = new Error('Server template not found');
		error.code = 'remote-config/not-found';
		error.hasCode = (code) => `remote-config/${code}` === error.code;
		return error;
	}

	it('builds a server template payload with only conditions and parameters', () => {
		const built = script.buildServerTemplate(
			{ parameters: { NEWS_ALERT_THRESHOLD: { defaultValue: { value: '0.7' } } } },
			{ conditions: [{ name: 'c1' }], etag: 'etag-1' },
		);

		expect(built.conditions).toEqual([{ name: 'c1' }]);
		expect(built.parameters).toEqual({ NEWS_ALERT_THRESHOLD: { defaultValue: { value: '0.7' } } });
		// parameterGroups and version are not accepted by the server namespace
		expect(built.parameterGroups).toBeUndefined();
		expect(built.version).toBeUndefined();
	});

	it('bootstraps the firebase-server namespace with a wildcard If-Match when no template exists yet', async () => {
		remoteConfig.getServerTemplate.mockRejectedValue(notFoundError());
		client.send.mockResolvedValue(okResponse());

		await expect(script.publishServerTemplate(deps())).resolves.toBe(true);

		expect(client.send).toHaveBeenCalledTimes(1);
		const request = client.send.mock.calls[0][0];
		expect(request.method).toBe('PUT');
		expect(request.url).toContain('/namespaces/firebase-server/serverRemoteConfig');
		expect(request.headers['If-Match']).toBe('*');
		expect(request.data.parameters).toBeDefined();
	});

	it('uses the current ETag when the namespace already has a published template', async () => {
		remoteConfig.getServerTemplate.mockResolvedValue({
			toJSON: () => ({ conditions: [], parameters: {}, etag: 'etag-existing', version: { versionNumber: '4' } }),
		});
		client.send.mockResolvedValue(okResponse());

		await expect(script.publishServerTemplate(deps())).resolves.toBe(true);

		const request = client.send.mock.calls[0][0];
		expect(request.headers['If-Match']).toBe('etag-existing');
	});

	it('does not swallow a pre-publish read failure that is not a missing namespace', async () => {
		remoteConfig.getServerTemplate.mockRejectedValue(
			Object.assign(new Error('denied'), { code: 'remote-config/permission-denied' }),
		);

		await expect(script.publishServerTemplate(deps())).rejects.toThrow(/denied/);
		expect(client.send).not.toHaveBeenCalled();
	});

	it('surfaces a non-2xx publish response as a failure', async () => {
		remoteConfig.getServerTemplate.mockResolvedValue({
			toJSON: () => ({ conditions: [], parameters: {}, etag: 'etag-1' }),
		});
		client.send.mockResolvedValue({ status: 403 });

		await expect(script.publishServerTemplate(deps())).rejects.toThrow(/HTTP 403/);
	});

	it('requires a resolvable Firebase project id', async () => {
		delete process.env.FIREBASE_PROJECT_ID;
		delete process.env.GCLOUD_PROJECT;
		delete process.env.GOOGLE_CLOUD_PROJECT;

		await expect(script.publishServerTemplate(deps({ app: { options: {} } })))
			.rejects.toThrow(/project ID/i);
		expect(client.send).not.toHaveBeenCalled();
	});

	it('reads a repository template that only carries server-namespace-safe top-level keys', () => {
		const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

		expect(Object.keys(template).sort()).toEqual(['parameters', 'version']);
		expect(typeof template.parameters).toBe('object');
		expect(Object.keys(template.parameters).length).toBeGreaterThan(0);
	});

	it('is wired to manual dispatch in the publish workflow and targets the server namespace', () => {
		const workflow = fs.readFileSync(workflowPath, 'utf8');

		expect(workflow).toContain('workflow_dispatch:');
		expect(workflow).toContain('deploy:firebase-remote-config:server');
		expect(workflow).toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
	});
});
