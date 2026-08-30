const fs = require('fs');
const path = require('path');

const readWorkflow = (name) =>
  fs.readFileSync(path.join(__dirname, '../../.github/workflows', name), 'utf8');

describe('security workflows', () => {
  it('scans pushes and pull requests with full git history', () => {
    const workflow = readWorkflow('secret-scan.yml');

    expect(workflow).toMatch(/push:/);
    expect(workflow).toMatch(/pull_request:/);
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/actions\/checkout@[^\s]+[\s\S]*fetch-depth: 0/);
    expect(workflow).toMatch(/gitleaks\/gitleaks-action@[^\s]+/);
    expect(workflow).toMatch(/GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  });

  it.each(['node.js.yml', 'env-drift-check.yml'])(
    'limits %s to read-only repository contents',
    (name) => {
      expect(readWorkflow(name)).toMatch(/permissions:\s*\n\s+contents: read/);
    },
  );
});
