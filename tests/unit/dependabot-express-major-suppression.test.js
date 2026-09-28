const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '..', '.github', 'dependabot.yml');

function loadConfig() {
  return fs.readFileSync(CONFIG_PATH, 'utf8');
}

describe('dependabot express major suppression (CB-259 / GH-558)', () => {
  let raw;

  beforeAll(() => {
    raw = loadConfig();
  });

  it('declares the npm package ecosystem', () => {
    expect(raw).toMatch(/package-ecosystem:\s*"npm"/);
  });

  it('sets a directory rooted at the repo root', () => {
    expect(raw).toMatch(/directory:\s*"\/"/);
  });

  it('ignores express version-update:semver-major inside the npm ecosystem block', () => {
    const npmBlockMatch = raw.match(/package-ecosystem:\s*"npm"[\s\S]*?(?=\n\s*- package-ecosystem:|\s*$)/);
    expect(npmBlockMatch).not.toBeNull();
    const npmBlock = npmBlockMatch[0];
    expect(npmBlock).toMatch(/ignore:/);
    expect(npmBlock).toMatch(/dependency-name:\s*"express"/);
    expect(npmBlock).toMatch(/update-types:\s*\[\s*"version-update:semver-major"\s*\]/);
  });
});
