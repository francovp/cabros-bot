const { execSync } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');

// Read package.json to get required Node version
const packageJsonPath = join(__dirname, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const requiredVersion = packageJson.engines.node;

// Get current Node version
const currentVersion = process.version;

// Simple version comparison function
function satisfiesRequiredVersion(current, required) {
  // Remove 'v' prefix from current version if present
  const cleanCurrent = current.startsWith('v') ? current.slice(1) : current;
  
  // Handle version ranges like "20.x"
  if (required.endsWith('.x')) {
    const majorMinor = required.slice(0, -2); // Remove ".x"
    const [requiredMajor, requiredMinor] = majorMinor.split('.').map(Number);
    const [currentMajor, currentMinor] = cleanCurrent.split('.').map(Number);
    
    return currentMajor === requiredMajor && currentMinor === requiredMinor;
  }
  
  // For exact versions or other formats, use semver (simplified)
  // In a real implementation, you'd use a proper semver library
  return cleanCurrent === required;
}

// Check if current version satisfies required version
if (!satisfiesRequiredVersion(currentVersion, requiredVersion)) {
  console.error(`\x1b[31mError: Node.js version ${requiredVersion} is required, but you are using ${currentVersion}.\x1b[0m`);
  console.error('\x1b[33mPlease install the correct Node.js version:\x1b[0m');
  console.error('  - Using nvm: nvm install && nvm use');
  console.error('  - Or download from: https://nodejs.org/');
  process.exit(1);
}

// If we reach here, version is correct
console.log(`\x1b[32m✓ Node.js version ${currentVersion} satisfies required version ${requiredVersion}\x1b[0m`);