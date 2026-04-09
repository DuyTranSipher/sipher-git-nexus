/**
 * `gitnexus unreal` CLI command namespace
 *
 * Subcommands: init, sync, status
 * Makes Unreal Engine support discoverable and works on first use.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { createInterface } from 'readline/promises';
import { fileURLToPath } from 'url';
import { getStoragePaths } from '../storage/repo-manager.js';
import { getGitRoot } from '../storage/git.js';
import type { UnrealConfig } from '../unreal/types.js';
import {
  findUProjectFile,
  resolveEditorCmd,
  installUnrealPlugin,
  updateUnrealPlugin,
  removeUnrealPlugin,
  buildUnrealPlugin,
} from '../unreal/plugin-setup.js';

// ─── Helpers ──────────────────────────────────────────────────────────

const __cliDirname = path.dirname(fileURLToPath(import.meta.url));

function getCliVersion(): string {
  const pkgPath = path.join(__cliDirname, '..', '..', 'package.json');
  return JSON.parse(fsSync.readFileSync(pkgPath, 'utf-8')).version;
}

function printStalenessWarning(config: UnrealConfig): void {
  const cliVersion = getCliVersion();
  const installed = config.installed_version;
  if (!installed) {
    console.log('  Note: Plugin version unknown — run "gitnexus unreal update" to stamp version.\n');
  } else if (installed !== cliVersion) {
    console.log(`  Warning: Plugin was installed by gitnexus v${installed} but you are running v${cliVersion}.`);
    console.log('  Run "gitnexus unreal update" to update the commandlet plugin.\n');
  }
}

// ─── init ──────────────────────────────────────────────────────────────

export async function unrealInitCommand(options?: {
  project?: string;
  editorCmd?: string;
}): Promise<void> {
  const projectRoot = path.resolve(options?.project || process.cwd());

  // Find .uproject files
  let uprojectFiles: string[];
  try {
    const entries = await fs.readdir(projectRoot);
    uprojectFiles = entries.filter(f => f.endsWith('.uproject'));
  } catch (err: any) {
    console.error(`Error: Cannot read directory "${projectRoot}": ${err.message}`);
    process.exit(1);
  }

  if (uprojectFiles.length === 0) {
    console.error(`Error: No .uproject file found in "${projectRoot}".`);
    console.error('Make sure you are in an Unreal Engine project root, or pass --project <path>.');
    process.exit(1);
  }

  const uprojectFile = uprojectFiles[0];
  const projectPath = path.join(projectRoot, uprojectFile);
  const projectName = path.basename(uprojectFile, '.uproject');

  // Resolve editor_cmd
  let editorCmd = options?.editorCmd || '';
  if (!editorCmd) {
    // Try to read from existing config
    const gitRoot = getGitRoot(projectRoot);
    if (gitRoot) {
      const { storagePath } = getStoragePaths(gitRoot);
      try {
        const { loadUnrealConfig } = await import('../unreal/config.js');
        const existing = await loadUnrealConfig(storagePath, gitRoot);
        if (existing?.editor_cmd) {
          editorCmd = existing.editor_cmd;
        }
      } catch { /* ignore */ }
    }
  }

  if (!editorCmd) {
    console.error('Warning: Could not auto-detect UnrealEditor-Cmd.exe path.');
    console.error('Pass --editor-cmd <path> or set it in .gitnexus-unreal.json.');
    editorCmd = '';
  }

  // Check plugin status
  const pluginDir = path.join(projectRoot, 'Plugins', 'GitNexusUnreal');
  let pluginInstalled = false;
  try {
    await fs.stat(pluginDir);
    pluginInstalled = true;
  } catch { /* not found */ }

  // Write config
  const gitRoot = getGitRoot(projectRoot);
  if (!gitRoot) {
    console.error('Error: Not inside a git repository. GitNexus requires a git repo.');
    process.exit(1);
  }

  const { storagePath } = getStoragePaths(gitRoot);
  const { ensureUnrealStorage, getUnrealStoragePaths } = await import('../unreal/config.js');
  await ensureUnrealStorage(storagePath);
  const unrealPaths = getUnrealStoragePaths(storagePath);

  const config: UnrealConfig = {
    editor_cmd: editorCmd,
    project_path: projectPath,
  };

  // Merge with existing config to preserve extra fields
  try {
    const raw = await fs.readFile(unrealPaths.config_path, 'utf-8');
    const existing = JSON.parse(raw) as Partial<UnrealConfig>;
    Object.assign(existing, config);
    await fs.writeFile(unrealPaths.config_path, JSON.stringify(existing, null, 2), 'utf-8');
  } catch {
    await fs.writeFile(unrealPaths.config_path, JSON.stringify(config, null, 2), 'utf-8');
  }

  // Print summary
  console.log('\nUnreal Engine project configured for GitNexus:\n');
  console.log(`  Project:     ${projectName}`);
  console.log(`  Path:        ${projectPath}`);
  console.log(`  Editor Cmd:  ${editorCmd || '(not set — pass --editor-cmd)'}`);
  console.log(`  Plugin:      ${pluginInstalled ? 'Installed' : 'Not found'}`);
  console.log(`  Config:      ${unrealPaths.config_path}`);

  if (!pluginInstalled) {
    console.log('\n  The GitNexusUnreal plugin is not installed.');
    console.log('  Run: gitnexus setup --unreal\n');
  } else if (!editorCmd) {
    console.log('\n  Set editor_cmd to enable Blueprint sync:');
    console.log('  gitnexus unreal init --editor-cmd "C:/Path/To/UnrealEditor-Cmd.exe"\n');
  } else {
    console.log('\n  Ready! Run: gitnexus unreal sync\n');
  }
}

// ─── sync ──────────────────────────────────────────────────────────────

export async function unrealSyncCommand(options?: {
  deep?: boolean;
  repo?: string;
}): Promise<void> {
  const mode = options?.deep ? 'deep' : 'metadata';
  const cwd = process.cwd();
  const gitRoot = getGitRoot(cwd);

  if (!gitRoot) {
    console.error('Error: Not inside a git repository.');
    process.exit(1);
  }

  const { storagePath } = getStoragePaths(gitRoot);
  const { loadUnrealConfig } = await import('../unreal/config.js');
  const config = await loadUnrealConfig(storagePath, gitRoot);

  if (!config) {
    console.error('Error: No Unreal config found.');
    console.error('Run: gitnexus unreal init');
    process.exit(1);
  }

  printStalenessWarning(config);

  const { syncUnrealAssetManifest } = await import('../unreal/bridge.js');
  const { withUnrealProgress } = await import('./unreal-progress.js');

  const result = await withUnrealProgress(
    () => syncUnrealAssetManifest(storagePath, config, gitRoot, options?.deep),
    {
      phaseLabel: `Syncing Unreal Blueprint assets (${mode} mode)`,
      successLabel: 'Sync complete',
      failLabel: 'Sync failed',
      isError: (r) => r.status === 'error',
    },
  );

  if (result.status === 'error') {
    console.error(`Error: ${result.error}`);
    if (result.warnings?.length) {
      for (const w of result.warnings) {
        console.error(`  Warning: ${w}`);
      }
    }
    process.exit(1);
  }

  console.log('');
  console.log(`  Assets:   ${result.asset_count?.toLocaleString() ?? 0}`);
  console.log(`  Mode:     ${mode}`);
  if (result.skipped_count != null && result.skipped_count > 0) {
    console.log(`  New:      ${result.new_count ?? 0}`);
    console.log(`  Skipped:  ${result.skipped_count}`);
  }
  if (result.manifest_path) {
    console.log(`  Manifest: ${result.manifest_path}`);
  }
  if (result.warnings?.length) {
    console.log('  Warnings:');
    for (const w of result.warnings) {
      console.log(`    - ${w}`);
    }
  }
}

// ─── status ────────────────────────────────────────────────────────────

export async function unrealStatusCommand(options?: {
  repo?: string;
}): Promise<void> {
  const cwd = process.cwd();
  const gitRoot = getGitRoot(cwd);

  if (!gitRoot) {
    console.error('Error: Not inside a git repository.');
    process.exit(1);
  }

  const { storagePath } = getStoragePaths(gitRoot);
  const { loadUnrealAssetManifest } = await import('../unreal/config.js');
  const manifest = await loadUnrealAssetManifest(storagePath);

  if (!manifest) {
    console.log('No Unreal assets indexed.');
    console.log('Run: gitnexus unreal sync');
    return;
  }

  // Last sync time
  const syncTime = manifest.generated_at
    ? new Date(manifest.generated_at).toLocaleString()
    : 'Unknown';

  console.log('\nUnreal Asset Index Status:\n');
  console.log(`  Last sync:    ${syncTime}`);
  console.log(`  Mode:         ${manifest.mode ?? 'metadata'}`);
  console.log(`  Total assets: ${manifest.assets.length.toLocaleString()}`);

  // Asset counts by type
  const typeCounts = new Map<string, number>();
  for (const asset of manifest.assets) {
    const assetClass = asset.asset_class || 'Blueprint';
    typeCounts.set(assetClass, (typeCounts.get(assetClass) || 0) + 1);
  }

  if (typeCounts.size > 1 || (typeCounts.size === 1 && !typeCounts.has('Blueprint'))) {
    console.log('  By type:');
    const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      console.log(`    ${type}: ${count.toLocaleString()}`);
    }
  }

  // Plugin version and staleness check
  const projectPath = manifest.project_path;
  if (projectPath) {
    const projectDir = path.dirname(projectPath);
    const upluginPath = path.join(projectDir, 'Plugins', 'GitNexusUnreal', 'GitNexusUnreal.uplugin');
    try {
      const raw = await fs.readFile(upluginPath, 'utf-8');
      const uplugin = JSON.parse(raw);
      if (uplugin.VersionName) {
        console.log(`  Plugin:      v${uplugin.VersionName}`);
      }
    } catch { /* plugin file not found */ }

    // Check junction health
    const pluginDir = path.join(projectDir, 'Plugins', 'GitNexusUnreal');
    try {
      const target = await fs.readlink(pluginDir);
      console.log(`  Link:        ${pluginDir} -> ${target}`);
    } catch {
      const pluginExists = await fs.stat(pluginDir).catch(() => null);
      if (pluginExists) {
        console.log('  Link:        (direct copy — run "gitnexus unreal update" to convert to junction)');
      }
    }

    // Version staleness
    const { loadUnrealConfig } = await import('../unreal/config.js');
    const config = await loadUnrealConfig(storagePath, gitRoot);
    if (config) {
      const cliVersion = getCliVersion();
      const installed = config.installed_version;
      if (!installed) {
        console.log('  Version:     Unknown — run "gitnexus unreal update" to stamp');
      } else if (installed === cliVersion) {
        console.log(`  Version:     v${installed} (up to date)`);
      } else {
        console.log(`  Version:     v${installed} -> v${cliVersion} available`);
        console.log('               Run "gitnexus unreal update" to update');
      }
    }
  }

  console.log('');
}

// ─── setup ─────────────────────────────────────────────────────────

async function promptForEditorCmd(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await rl.question('  Path to UnrealEditor-Cmd.exe: ');
      const trimmed = answer.trim();
      if (!trimmed) continue;
      try {
        await fs.access(trimmed);
        return trimmed;
      } catch {
        console.log(`  Not found: ${trimmed}`);
      }
    }
  } finally {
    rl.close();
  }
}

export async function unrealSetupCommand(options?: {
  project?: string;
  editorCmd?: string;
  force?: boolean;
}): Promise<void> {
  const projectRoot = path.resolve(options?.project || process.cwd());

  // Validate project root
  try {
    const stat = await fs.stat(projectRoot);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`Error: Project root not found: ${projectRoot}`);
    process.exit(1);
  }

  // Find .uproject
  let uprojectPath: string;
  try {
    uprojectPath = await findUProjectFile(projectRoot);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const projectName = path.basename(uprojectPath, '.uproject');

  // Read engine association from .uproject
  let engineAssociation = '';
  try {
    const uproject = JSON.parse(await fs.readFile(uprojectPath, 'utf-8'));
    engineAssociation = uproject.EngineAssociation || '';
  } catch (err: any) {
    console.error(`Error: Failed to read ${path.basename(uprojectPath)}: ${err.message}`);
    process.exit(1);
  }

  // Resolve editor_cmd — fall back to interactive prompt if auto-detection fails
  let editorCmd: string;
  try {
    editorCmd = resolveEditorCmd(options?.editorCmd, engineAssociation);
  } catch {
    console.log('  Could not auto-detect UnrealEditor-Cmd.exe.');
    console.log('  Tip: it lives at <EngineRoot>/Engine/Binaries/Win64/UnrealEditor-Cmd.exe');
    console.log('');
    editorCmd = await promptForEditorCmd();
  }

  console.log('');
  console.log(`  Project:  ${projectName}`);
  console.log(`  Editor:   ${editorCmd}`);
  console.log('');

  // Step 1: Install plugin + write config
  console.log('  [1/3] Installing plugin...');
  try {
    const installed = await installUnrealPlugin({
      projectRoot,
      editorCmd,
      uprojectPath,
      force: options?.force,
    });
    console.log(`        Plugin  → ${installed.pluginDest}`);
    console.log(`        Config  → ${installed.localConfigPath}`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  // Step 2: Build editor target via UnrealBuildTool
  console.log('');
  console.log(`  [2/3] Building ${projectName}Editor (this may take several minutes)...`);
  console.log('');
  try {
    await buildUnrealPlugin(editorCmd, projectName, uprojectPath);
  } catch (err: any) {
    console.error('');
    console.error(`Error: Build failed — ${err.message}`);
    console.error('  Fix the build error above, then re-run: gitnexus unreal setup --force');
    process.exit(1);
  }

  // Step 3: Sync Blueprint assets (deep mode)
  console.log('');
  console.log('  [3/3] Syncing Blueprint assets...');
  console.log('');
  await unrealSyncCommand({ deep: true });

  console.log('');
  console.log('  Setup complete!');
  console.log('  Run: gitnexus analyze   to index the C++ codebase');
  console.log('');
}

// ─── update ───────────────────────────────────────────────────────────

export async function unrealUpdateCommand(options?: {
  project?: string;
  build?: boolean;
}): Promise<void> {
  const projectRoot = path.resolve(options?.project || process.cwd());

  // Find .uproject for build step
  let uprojectPath: string;
  try {
    uprojectPath = await findUProjectFile(projectRoot);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  const projectName = path.basename(uprojectPath, '.uproject');

  // Load existing config for editor_cmd
  const gitRoot = getGitRoot(projectRoot);
  if (!gitRoot) {
    console.error('Error: Not inside a git repository.');
    process.exit(1);
  }
  const { storagePath } = getStoragePaths(gitRoot);
  const { loadUnrealConfig } = await import('../unreal/config.js');
  const config = await loadUnrealConfig(storagePath, gitRoot);

  if (!config) {
    console.error('Error: No Unreal config found. Run "gitnexus unreal setup" first.');
    process.exit(1);
  }

  // Step 1: Update junction and version stamp
  console.log('\n  [1/2] Updating plugin...');
  try {
    const result = await updateUnrealPlugin({ projectRoot });
    if (result.previousVersion) {
      console.log(`        v${result.previousVersion} -> v${result.newVersion}`);
    } else {
      console.log(`        Stamped v${result.newVersion}`);
    }
    if (result.junctionRecreated) {
      console.log(`        Junction -> ${result.pluginSource}`);
    } else {
      console.log('        Junction unchanged (already correct)');
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  // Step 2: Rebuild editor target
  if (options?.build === false) {
    console.log('\n  Skipping build (--no-build).');
    console.log('  Remember to rebuild the editor target before running sync.\n');
    return;
  }

  console.log('');
  console.log(`  [2/2] Rebuilding ${projectName}Editor...`);
  console.log('');
  try {
    await buildUnrealPlugin(config.editor_cmd, projectName, uprojectPath);
  } catch (err: any) {
    console.error('');
    console.error(`Error: Build failed — ${err.message}`);
    process.exit(1);
  }

  console.log('\n  Update complete!\n');
}

// ─── remove ───────────────────────────────────────────────────────────

export async function unrealRemoveCommand(options?: {
  project?: string;
  yes?: boolean;
  keepConfig?: boolean;
}): Promise<void> {
  const projectRoot = path.resolve(options?.project || process.cwd());

  // Check plugin exists
  const pluginDir = path.join(projectRoot, 'Plugins', 'GitNexusUnreal');
  const pluginExists = await fs.stat(pluginDir).catch(() => null);

  if (!pluginExists) {
    console.log('GitNexusUnreal plugin is not installed in this project.');
    return;
  }

  // Show what will be removed
  const toRemove = [pluginDir];
  const unrealStorageDir = path.join(projectRoot, '.gitnexus', 'unreal');
  if (await fs.stat(unrealStorageDir).catch(() => null)) {
    toRemove.push(unrealStorageDir);
  }
  if (!options?.keepConfig) {
    const sharedConfig = path.join(projectRoot, '.gitnexus-unreal.json');
    if (await fs.stat(sharedConfig).catch(() => null)) {
      toRemove.push(sharedConfig);
    }
  }

  console.log('\n  Will remove:');
  for (const p of toRemove) {
    console.log(`    - ${p}`);
  }
  if (options?.keepConfig) {
    console.log('  (keeping .gitnexus-unreal.json)');
  }

  // Confirm unless --yes
  if (!options?.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('\n  Proceed? [y/N] ');
      if (answer.trim().toLowerCase() !== 'y') {
        console.log('  Cancelled.\n');
        return;
      }
    } finally {
      rl.close();
    }
  }

  // Remove
  const result = await removeUnrealPlugin({
    projectRoot,
    keepConfig: options?.keepConfig,
  });

  console.log(`\n  Removed ${result.removed.length} item(s).`);
  console.log('  Note: You may need to regenerate project files and rebuild the editor.\n');
}
