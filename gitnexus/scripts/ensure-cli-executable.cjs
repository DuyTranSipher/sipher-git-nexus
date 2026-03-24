const fs = require('node:fs');
const path = require('node:path');

const cliPath = path.join(__dirname, '..', 'dist', 'cli', 'index.js');

if (!fs.existsSync(cliPath)) {
  console.warn(`[prepack] Skipping executable bit because ${cliPath} does not exist.`);
  process.exit(0);
}

try {
  fs.chmodSync(cliPath, 0o755);
} catch (error) {
  if (process.platform === 'win32') {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[prepack] Continuing without chmod on Windows: ${message}`);
    process.exit(0);
  }

  throw error;
}
