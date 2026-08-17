'use strict';

const fs = require('fs');
const path = require('path');

const srcAdminDir = path.join(__dirname, '../src/admin');
const publicDir = path.join(__dirname, '../public');
const publicAdminDir = path.join(publicDir, 'admin');

function buildHosting() {
	if (!fs.existsSync(publicDir)) {
		fs.mkdirSync(publicDir, { recursive: true });
	}
	if (!fs.existsSync(publicAdminDir)) {
		fs.mkdirSync(publicAdminDir, { recursive: true });
	}

	const files = fs.readdirSync(srcAdminDir);
	for (const file of files) {
		const srcFile = path.join(srcAdminDir, file);
		const destFile = path.join(publicAdminDir, file);
		if (fs.statSync(srcFile).isFile()) {
			fs.copyFileSync(srcFile, destFile);
		}
	}

	// Create root index.html that redirects to /admin or loads console
	const rootIndexHtml = `<!doctype html>
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
	fs.writeFileSync(path.join(publicDir, 'index.html'), rootIndexHtml, 'utf8');
	console.log(`[build:hosting] Copied ${files.length} admin assets to ${publicAdminDir} and generated ${path.join(publicDir, 'index.html')}`);
}

if (require.main === module) {
	buildHosting();
}

module.exports = { buildHosting };
