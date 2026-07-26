const fs = require('fs');
const path = require('path');

describe('Documentation Alignment Policy', () => {
  const repoRoot = path.resolve(__dirname, '../../');
  
  test('maintained quickstarts and tasks should not use npm commands', () => {
    const specFiles = [
      'specs/001-gemini-grounding-alert/quickstart.md',
      'specs/001-gemini-grounding-alert/tasks.md',
      'specs/002-whatsapp-alerts/quickstart.md',
      'specs/002-whatsapp-alerts/tasks.md',
      'specs/003-news-monitor/quickstart.md',
      'specs/003-news-monitor/tasks.md',
      'specs/004-enrich-alert-output/tasks.md',
    ];

    const forbiddenPatterns = [
      /\bnpm install\b/i,
      /\bnpm run\b/i,
      /\bnpm test\b/i,
      /\bnpm start\b/i,
    ];

    for (const relPath of specFiles) {
      const fullPath = path.join(repoRoot, relPath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const pattern of forbiddenPatterns) {
          expect({ file: relPath, match: content.match(pattern) })
            .toEqual({ file: relPath, match: null });
        }
      }
    }
  });

  test('documentation should not claim prettylink is installed', () => {
    const docFiles = [
      'AGENTS.md',
      'specs/003-news-monitor/plan.md',
      'specs/003-news-monitor/spec.md',
      'specs/003-news-monitor/research.md',
      'specs/003-news-monitor/tasks.md',
    ];

    for (const relPath of docFiles) {
      const fullPath = path.join(repoRoot, relPath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        expect(content.includes('prettylink npm package')).toBe(false);
        expect(content.includes('package.json to add Azure dependencies + prettylink')).toBe(false);
      }
    }
  });
});
