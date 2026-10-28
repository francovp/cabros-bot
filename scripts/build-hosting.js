'use strict';

/* global require, module, __dirname, console, process */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const defaultSrcAdminDir = path.join(__dirname, '../src/admin');
const defaultPublicDir = path.join(__dirname, '../public');

const ROOT_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=/admin">
  <title>Redirecting to Cabros Bot Console...</title>
  <script>window.location.replace('/admin');</script>
</head>
<body>
  <p>Redirecting to <a href="/admin">Cabros Bot Console</a>...</p>
</body>
</html>
`;

function digest(filePath) {
	return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildHosting({ sourceAdminDir = defaultSrcAdminDir, publicDir = defaultPublicDir } = {}) {
	const publicAdminDir = path.join(publicDir, 'admin');
	// Pin the self-hosted runtime to the lockfile for Express and Firebase parity.
	fs.copyFileSync(require.resolve('vue/dist/vue.runtime.global.prod.js'), path.join(sourceAdminDir, 'vue.runtime.global.prod.js'));
	if (!fs.existsSync(publicDir)) {
		fs.mkdirSync(publicDir, { recursive: true });
	}
	if (!fs.existsSync(publicAdminDir)) {
		fs.mkdirSync(publicAdminDir, { recursive: true });
	}

	const files = fs.readdirSync(sourceAdminDir);
	for (const file of files) {
		const srcFile = path.join(sourceAdminDir, file);
		const destFile = path.join(publicAdminDir, file);
		if (fs.statSync(srcFile).isFile()) {
			fs.copyFileSync(srcFile, destFile);
		}
	}

	// Create root index.html that redirects to /admin or loads console
	fs.writeFileSync(path.join(publicDir, 'index.html'), ROOT_INDEX_HTML, 'utf8');
	console.log(`[build:hosting] Copied ${files.length} admin assets to ${publicAdminDir} and generated ${path.join(publicDir, 'index.html')}`);
}

function checkAdminDrift({ sourceAdminDir = defaultSrcAdminDir, publicDir = defaultPublicDir } = {}) {
	const publicAdminDir = path.join(publicDir, 'admin');
	const errors = [];

	if (!fs.existsSync(sourceAdminDir)) {
		throw new Error(`Source admin directory does not exist: ${sourceAdminDir}`);
	}
	if (!fs.existsSync(publicAdminDir)) {
		errors.push(`Public admin directory missing: ${publicAdminDir}`);
	} else {
		const srcFiles = fs.readdirSync(sourceAdminDir).filter((f) => fs.statSync(path.join(sourceAdminDir, f)).isFile()).sort();
		const publicFiles = fs.readdirSync(publicAdminDir).filter((f) => fs.statSync(path.join(publicAdminDir, f)).isFile()).sort();

		// Check each source file has a byte-identical counterpart in public/admin
		for (const file of srcFiles) {
			const srcFile = path.join(sourceAdminDir, file);
			const publicFile = path.join(publicAdminDir, file);
			if (!fs.existsSync(publicFile)) {
				errors.push(`Missing in public/admin: ${file}`);
			} else if (digest(srcFile) !== digest(publicFile)) {
				errors.push(`public/admin/${file} differs from src/admin/${file}`);
			}
		}

		// Check for extra/orphan files in public/admin
		for (const file of publicFiles) {
			if (!srcFiles.includes(file)) {
				errors.push(`Extra file in public/admin without source in src/admin: ${file}`);
			}
		}
	}

	// Check root index.html
	const rootIndexFile = path.join(publicDir, 'index.html');
	if (!fs.existsSync(rootIndexFile)) {
		errors.push('Missing public/index.html');
	} else {
		const content = fs.readFileSync(rootIndexFile, 'utf8');
		if (content !== ROOT_INDEX_HTML) {
			errors.push('public/index.html does not match expected redirect content');
		}
	}

	if (errors.length > 0) {
		const message = [
			'generated hosting assets are out of date; run pnpm run build:hosting',
			...errors.map((e) => `  - ${e}`),
		].join('\n');
		return { ok: false, message, errors };
	}

	return { ok: true, message: 'Admin hosting assets are in sync.' };
}

if (require.main === module) {
	if (process.argv.includes('--check')) {
		const result = checkAdminDrift();
		if (!result.ok) {
			console.error(result.message);
			process.exit(1);
		}
		console.log(`[check:admin-drift] ${result.message}`);
	} else {
		buildHosting();
	}
}

module.exports = { buildHosting, checkAdminDrift, ROOT_INDEX_HTML };
