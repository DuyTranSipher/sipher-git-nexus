/**
 * Changelog Command
 *
 * Displays release notes from CHANGELOG.md bundled with the package.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');

export const changelogCommand = async (options: { version?: string; all?: boolean }) => {
  const changelogPath = path.join(__dirname, '..', '..', 'CHANGELOG.md');

  let content: string;
  try {
    content = await fs.readFile(changelogPath, 'utf-8');
  } catch {
    console.error('CHANGELOG.md not found in package.');
    process.exitCode = 1;
    return;
  }

  console.log(`  @duytransipher/gitnexus v${pkg.version}\n`);

  if (options.all) {
    console.log(content);
    return;
  }

  // Parse sections by version heading: ## [x.y.z] - date
  const sections = content.split(/^(?=## \[)/m).filter(s => s.startsWith('## ['));

  if (options.version) {
    const target = options.version.replace(/^v/, '');
    const match = sections.find(s => s.startsWith(`## [${target}]`));
    if (match) {
      console.log(match.trim());
    } else {
      console.log(`  No changelog entry found for version ${target}.`);
      console.log(`  Available versions: ${sections.map(s => s.match(/## \[(.+?)\]/)?.[1]).filter(Boolean).join(', ')}`);
    }
    return;
  }

  // Default: show latest 3 versions
  const latest = sections.slice(0, 3);
  for (const section of latest) {
    console.log(section.trim());
    console.log('');
  }

  if (sections.length > 3) {
    console.log(`  ... and ${sections.length - 3} older versions. Use --all to see everything.`);
  }
};
