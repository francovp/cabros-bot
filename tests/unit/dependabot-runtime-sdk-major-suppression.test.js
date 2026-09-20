const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '..', '.github', 'dependabot.yml');
const AUDIT_DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'runtime-sdk-major-drift-audit.md');
const PKG_PATH = path.join(__dirname, '..', '..', 'package.json');

const AUDITED_RUNTIME_PACKAGES = [
  '@google/genai',
  'firebase-admin',
  'bullmq',
  'ioredis',
  'openai',
  'binance',
  'undici',
  'uuid',
  'helmet',
  'dotenv',
];

function loadConfig() {
  return fs.readFileSync(CONFIG_PATH, 'utf8');
}

function loadAuditDoc() {
  return fs.readFileSync(AUDIT_DOC_PATH, 'utf8');
}

function loadPackageJson() {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
}

describe('dependabot runtime SDK major suppression (GH-1170)', () => {
  let rawConfig;
  let rawAuditDoc;
  let packageJson;

  beforeAll(() => {
    rawConfig = loadConfig();
    rawAuditDoc = loadAuditDoc();
    packageJson = loadPackageJson();
  });

  it('declares the npm package ecosystem rooted at "/"', () => {
    expect(rawConfig).toMatch(/package-ecosystem:\s*"npm"/);
    expect(rawConfig).toMatch(/directory:\s*"\/"/);
  });

  describe.each(AUDITED_RUNTIME_PACKAGES)('package: %s', (pkgName) => {
    it('ignores semver-major updates in .github/dependabot.yml', () => {
      const npmBlockMatch = rawConfig.match(/package-ecosystem:\s*"npm"[\s\S]*?(?=\n\s*- package-ecosystem:|\s*$)/);
      expect(npmBlockMatch).not.toBeNull();
      const npmBlock = npmBlockMatch[0];

      // Escape package name for regex (e.g. @google/genai)
      const escapedPkg = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `dependency-name:\\s*"${escapedPkg}"(?:(?!dependency-name)[\\s\\S])*?update-types:\\s*\\[\\s*"version-update:semver-major"\\s*\\]`
      );
      expect(npmBlock).toMatch(pattern);
    });

    it('documents compatibility hold, code surface, and revisit date in audit doc', () => {
      expect(rawAuditDoc).toContain(pkgName);
      expect(rawAuditDoc).toMatch(/Compatibility Hold/);
      expect(rawAuditDoc).toMatch(/2026-12-31/);
    });

    it('is declared in package.json dependencies', () => {
      expect(packageJson.dependencies).toHaveProperty(pkgName);
    });
  });

  it('audit document explicitly references GH-1170', () => {
    expect(rawAuditDoc).toMatch(/#1170/);
  });
});
