const fs = require('fs');
const path = require('path');

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else if (file.endsWith('.md')) {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
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
});
