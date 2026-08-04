const fs = require('fs');
const path = require('path');

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else if (['.md', '.yml', '.yaml'].some(extension => file.endsWith(extension))) {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
}

function getJavaScriptFiles(dirPath, arrayOfFiles = []) {
	if (!fs.existsSync(dirPath)) return arrayOfFiles;

	for (const file of fs.readdirSync(dirPath)) {
		const fullPath = path.join(dirPath, file);
		if (fs.statSync(fullPath).isDirectory()) {
			getJavaScriptFiles(fullPath, arrayOfFiles);
		} else if (file.endsWith('.js')) {
			arrayOfFiles.push(fullPath);
		}
	}

	return arrayOfFiles;
}

const ENVIRONMENT_CLASSIFICATIONS = {
	APPDATA: 'platform-injected credential path',
	COMMIT_SHA: 'platform-injected release metadata',
	ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE: 'deprecated compatibility alias',
	ENABLE_TEST_RATE_LIMITER: 'test-only override',
	FUNCTION_NAME: 'platform-injected runtime metadata',
	FUNCTION_TARGET: 'platform-injected runtime metadata',
	GAE_SERVICE: 'platform-injected runtime metadata',
	GCE_METADATA_HOST: 'platform-injected runtime metadata',
	GCE_METADATA_IP: 'platform-injected runtime metadata',
	GCLOUD_PROJECT: 'platform-injected project metadata',
	GITHUB_SHA: 'platform-injected release metadata',
	GIT_COMMIT: 'platform-injected release metadata',
	GOOGLE_CLOUD_PROJECT: 'platform-injected project metadata',
	HOME: 'platform-injected credential path',
	JEST_WORKER_ID: 'test-only runtime metadata',
	K_REVISION: 'platform-injected runtime metadata',
	K_SERVICE: 'platform-injected runtime metadata',
	NODE_ENV: 'platform-injected runtime mode',
	RENDER_GIT_COMMIT: 'platform-injected release metadata',
	RENDER_GIT_REPO_SLUG: 'platform-injected release metadata',
	SIGNAL_OUTCOME_EVALUATION_CADENCE_MS: 'deprecated compatibility alias',
	SOURCE_VERSION: 'platform-injected release metadata',
};

function getStaticEnvironmentReads(repoRoot) {
	const sourceFiles = [
		path.join(repoRoot, 'index.js'),
		path.join(repoRoot, 'app.js'),
		path.join(repoRoot, 'instrument.js'),
		...getJavaScriptFiles(path.join(repoRoot, 'src')),
	].filter(fullPath => fs.existsSync(fullPath));

	const names = new Set();
	const patterns = [
		/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
		/\bprocess\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
	];

	for (const fullPath of sourceFiles) {
		const content = fs.readFileSync(fullPath, 'utf8');
		for (const pattern of patterns) {
			for (const match of content.matchAll(pattern)) names.add(match[1]);
		}
	}

	return names;
}

function getEnvironmentTemplateKeys(content) {
	return new Set(
		[...content.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map(match => match[1]),
	);
}

describe('Documentation Alignment Policy', () => {
  const repoRoot = path.resolve(__dirname, '../../');

  test('maintained quickstarts and tasks should not use npm commands', () => {
    const specFiles = getAllFiles(path.join(repoRoot, 'specs'));
    const forbiddenPatterns = [
      /\bnpm install\b/i,
      /\bnpm run\b/i,
      /\bnpm test\b/i,
      /\bnpm start\b/i,
    ];

    for (const fullPath of specFiles) {
      const relPath = path.relative(repoRoot, fullPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const pattern of forbiddenPatterns) {
        expect({ file: relPath, match: content.match(pattern) })
          .toEqual({ file: relPath, match: null });
      }
    }
  });

  test('documentation should not claim prettylink is installed or required', () => {
    const docFiles = [
      path.join(repoRoot, 'AGENTS.md'),
      ...getAllFiles(path.join(repoRoot, 'specs')),
    ];

    for (const fullPath of docFiles) {
      const relPath = path.relative(repoRoot, fullPath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        expect({ file: relPath, match: content.match(/prettylink/i) })
          .toEqual({ file: relPath, match: null });
      }
    }
  });

  test('news-monitor documentation matches runtime configuration', () => {
    const maintainedFiles = [
      path.join(repoRoot, '.env.example'),
      path.join(repoRoot, 'README.md'),
      path.join(repoRoot, 'agents.md'),
      ...getAllFiles(path.join(repoRoot, 'specs', '003-news-monitor')),
    ];
    const staleConfigurationPatterns = [
      /\bAZURE_AI_(?:ENDPOINT|API_KEY|MODEL)\s*=/i,
      /^\s*URL_SHORTENER_SERVICE\s*=\s*(?:bitly|reurl|pixnet0rz\.tw)\b/im,
      /^\s*(?:BITLY_(?:API_KEY|ACCESS_TOKEN)|REURL_(?:API_KEY|ACCESS_TOKEN)|PIXNET0RZ(?:_TW)?_(?:API_KEY|ACCESS_TOKEN))\s*=/im,
      /https?:\/\/bit\.ly\//i,
      /\btitles?[- ]only\b/i,
    ];

    for (const fullPath of maintainedFiles) {
      const relPath = path.relative(repoRoot, fullPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const pattern of staleConfigurationPatterns) {
        expect({ file: relPath, match: content.match(pattern) })
          .toEqual({ file: relPath, match: null });
      }
    }

    const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
    expect(envExample).toContain('URL_SHORTENER_SERVICE=picsee');
    expect(envExample).toContain('PICSEE_API_KEY=');
    expect(envExample).toContain('CUTTLY_API_KEY=');
    expect(envExample).toContain('AZURE_LLM_ENDPOINT=');
  });

	test('application-owned environment reads are documented or explicitly classified', () => {
		const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
		const documentedKeys = getEnvironmentTemplateKeys(envExample);
		const undocumentedKeys = [...getStaticEnvironmentReads(repoRoot)]
			.filter(key => !documentedKeys.has(key) && !ENVIRONMENT_CLASSIFICATIONS[key])
			.sort();

		expect(undocumentedKeys).toEqual([]);
	});
});
