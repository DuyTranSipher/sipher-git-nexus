#!/usr/bin/env node
/**
 * Copy gitnexus-unreal/GitNexusUnreal into vendor/GitNexusUnreal.
 *
 * Runs automatically via `prepack` so the npm tarball always contains
 * the latest plugin source. Also callable manually: npm run sync-vendor.
 *
 * Exits 0 silently when the monorepo source directory is absent
 * (e.g. when running from an installed npm package).
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'gitnexus-unreal', 'GitNexusUnreal');
const dest = path.join(__dirname, '..', 'vendor', 'GitNexusUnreal');

if (!fs.existsSync(src)) {
  // Not in the monorepo — nothing to sync.
  process.exit(0);
}

// Clean destination and copy fresh.
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });

// Count files for summary.
let count = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(path.join(dir, entry.name));
    else count++;
  }
};
walk(dest);

console.log(`[sync-vendor] Copied ${count} files from gitnexus-unreal/GitNexusUnreal -> vendor/GitNexusUnreal`);
