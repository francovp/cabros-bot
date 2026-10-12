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

  it('allowlists only the tracked public Firebase key in the Render blueprint', () => {
    const config = fs.readFileSync(
      path.join(__dirname, '../../.gitleaks.toml'),
      'utf8',
    );

    expect(config).toContain('render\\.yaml');
    expect(config).toMatch(/AIzaSyDskGc5b0hpVX6YIUW-IYqwuH7_ZIP07O0/);
    expect(config).toContain('condition = "AND"');
  });

  // A `paths` entry in a global allowlist combines permissively with every other
  // criterion, so listing one suppresses *all* findings in that file. On gitleaks
  // 8.24.3 (what gitleaks-action@v3 pins) that was verified to hide a real
  // `xoxb-…` Slack token planted in `generic-message-webhook.test.js`. The
  // exception has to stay scoped to the single offending value so a credential
  // later committed to that same file is still reported.
  it('keeps the gitleaks test-fixture exception scoped to a value, never a file path', () => {
    const config = fs.readFileSync(
      path.join(__dirname, '../../.gitleaks.toml'),
      'utf8',
    );

    expect(config).toMatch(/stopwords = \['''msg-divergent-idem-001'''\]/);

    // Scope to the global `[allowlist]` table, which is the last table in the
    // file. The `render.yaml` entry is a separate `[[allowlists]]` entry gated on
    // `condition = "AND"`, and that is the only `paths` entry the config may
    // carry. Comments are stripped first: an unstripped search would match prose
    // that merely names the table.
    const uncommented = config
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');
    const globalAllowlist = uncommented.slice(uncommented.indexOf('\n[allowlist]'));

    expect(globalAllowlist).not.toMatch(/^\s*paths\s*=/m);
  });

  it.each(['node.js.yml', 'env-drift-check.yml'])(
    'limits %s to read-only repository contents',
    (name) => {
      expect(readWorkflow(name)).toMatch(/permissions:\s*\n\s+contents: read/);
    },
  );
});
