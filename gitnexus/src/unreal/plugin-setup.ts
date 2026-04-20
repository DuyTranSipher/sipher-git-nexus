/**
 * Shared Unreal plugin installation utilities.
 * Used by `gitnexus unreal setup`.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Helpers ──────────────────────────────────────────────────────

function getCliVersion(): string {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  return JSON.parse(fsSync.readFileSync(pkgPath, 'utf-8')).version;
}

/**
 * Resolve the plugin source directory.
 * Prefers vendor/ (npm installs), falls back to monorepo source checkout.
 */
function resolvePluginSource(): string {
  const vendorPlugin = path.resolve(path.join(__dirname, '..', '..', 'vendor', 'GitNexusUnreal'));
  if (fsSync.existsSync(vendorPlugin) && fsSync.statSync(vendorPlugin).isDirectory()) {
    return vendorPlugin;
  }
  const monorepoPlugin = path.resolve(path.join(__dirname, '..', '..', '..', 'gitnexus-unreal', 'GitNexusUnreal'));
  if (fsSync.existsSync(monorepoPlugin) && fsSync.statSync(monorepoPlugin).isDirectory()) {
    return monorepoPlugin;
  }
  throw new Error(
    'GitNexusUnreal plugin source not found. '
    + 'If running from source, ensure gitnexus-unreal/ exists. '
    + 'If installed via npm, reinstall the package.'
  );
}

// ─── Project detection ─────────────────────────────────────────────

export async function findUProjectFile(projectRoot: string): Promise<string> {
  const entries = await fs.readdir(projectRoot);
  const uprojects = entries.filter(e => e.endsWith('.uproject'));
  if (uprojects.length === 0) {
    throw new Error(`No .uproject file found in ${projectRoot}. Use --project to specify the UE project root.`);
  }
  if (uprojects.length > 1) {
    throw new Error(`Multiple .uproject files in ${projectRoot}: ${uprojects.join(', ')}. Move into the correct project directory or use --project.`);
  }
  return path.join(projectRoot, uprojects[0]);
}

// ─── Engine layout resolution ──────────────────────────────────────

/**
 * A validated Unreal Engine installation layout.
 *
 * `engineRoot` is the install root (e.g. `C:\Program Files\Epic Games\UE_5.5`
 * or `C:\SipherUE-5.7.2`). `editorCmd` and `buildBat` are absolute paths that
 * are guaranteed to exist on disk at probe time.
 */
export interface EngineLayout {
  engineRoot: string;
  editorCmd: string;
  buildBat: string;
}

/**
 * Given a candidate engine install root, test the known UE directory layouts
 * and return the first one where BOTH `UnrealEditor-Cmd.exe` and `Build.bat`
 * exist on disk. Returns null if nothing matches.
 *
 * Layouts supported:
 *   1. Standard UE:        <root>/Engine/Binaries/Win64/UnrealEditor-Cmd.exe
 *                          <root>/Engine/Build/BatchFiles/Build.bat
 *   2. Sipher source build: <root>/Engine/Windows/Engine/Binaries/Win64/UnrealEditor-Cmd.exe
 *                          <root>/Engine/Build/BatchFiles/Build.bat   (Build.bat is NOT nested)
 */
function probeEngineLayout(engineRoot: string): EngineLayout | null {
  const layouts: Array<Omit<EngineLayout, 'engineRoot'>> = [
    {
      editorCmd: path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'),
      buildBat: path.join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat'),
    },
    {
      editorCmd: path.join(engineRoot, 'Engine', 'Windows', 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'),
      buildBat: path.join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat'),
    },
  ];
  for (const l of layouts) {
    try {
      if (fsSync.statSync(l.editorCmd).isFile() && fsSync.statSync(l.buildBat).isFile()) {
        return { engineRoot, ...l };
      }
    } catch { /* next */ }
  }
  return null;
}

/**
 * Accept either an engine root OR a path to UnrealEditor-Cmd.exe, walk up to
 * the root if needed, and return a validated layout. Used to honor user
 * overrides like a stored `editor_cmd` or `--editor-cmd` argument.
 */
function tryEngineRootCandidate(rootOrExe: string): EngineLayout | null {
  const normalized = rootOrExe.replace(/\//g, '\\');
  if (normalized.toLowerCase().endsWith('.exe')) {
    // Walk up to the engine root using known layout tails.
    const tailPatterns = [
      /^(.*?)\\Engine\\Windows\\Engine\\Binaries\\Win64\\[^\\]+\.exe$/i,
      /^(.*?)\\Engine\\Binaries\\Win64\\[^\\]+\.exe$/i,
    ];
    for (const p of tailPatterns) {
      const m = normalized.match(p);
      if (m) {
        const layout = probeEngineLayout(m[1]);
        if (layout) return layout;
      }
    }
    return null;
  }
  return probeEngineLayout(normalized);
}

/**
 * Resolve a fully-validated Unreal Engine install at runtime.
 *
 * Lookup order:
 *   1. `explicitHint` — a user-supplied path (either an engine root or
 *      UnrealEditor-Cmd.exe). A stale or invalid hint silently falls through
 *      to dynamic detection, so users who moved their engine still get fixed.
 *   2. Registry `HKCU\Software\Epic Games\Unreal Engine\Builds\<GUID>`
 *      (source builds — kept live by Setup.bat and the "Switch Engine Version" dialog).
 *   3. `%LOCALAPPDATA%/EpicGames/UnrealEngineLauncher/LauncherInstalled.dat`
 *      (Epic Games Launcher installs).
 *   4. Standard launcher path `C:\Program Files\Epic Games\UE_<version>`.
 *
 * Throws with actionable guidance if all sources fail.
 */
export function resolveEngineLayout(
  engineAssociation: string,
  explicitHint?: string,
): EngineLayout {
  if (explicitHint) {
    const resolved = path.resolve(explicitHint);
    const layout = tryEngineRootCandidate(resolved);
    if (layout) return layout;
    // Stale hint — fall through to dynamic resolution.
  }

  if (process.platform !== 'win32') {
    throw new Error('Auto-detection of Unreal Engine is only supported on Windows. Pass --editor-cmd <path-to-UnrealEditor-Cmd.exe>.');
  }

  if (engineAssociation) {
    // Registry lookup (GUID engine association for source builds)
    try {
      const regQuery = `reg query "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds" /v "${engineAssociation}" 2>nul`;
      const output = execSync(regQuery, { encoding: 'utf-8' });
      const match = output.match(/REG_SZ\s+(.+)/);
      if (match) {
        const layout = tryEngineRootCandidate(match[1].trim());
        if (layout) return layout;
      }
    } catch { /* registry key not found */ }

    // Epic Games Launcher installs
    try {
      const launcherDat = path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'EpicGames', 'UnrealEngineLauncher', 'LauncherInstalled.dat'
      );
      const launcher = JSON.parse(fsSync.readFileSync(launcherDat, 'utf-8'));
      if (Array.isArray(launcher.InstallationList)) {
        for (const entry of launcher.InstallationList) {
          if (entry.AppName === `UE_${engineAssociation}` || entry.AppName === engineAssociation) {
            const layout = tryEngineRootCandidate(entry.InstallLocation);
            if (layout) return layout;
          }
        }
      }
    } catch { /* LauncherInstalled.dat missing or unreadable */ }

    // Standard launcher path
    const layout = tryEngineRootCandidate(path.join('C:\\Program Files\\Epic Games', `UE_${engineAssociation}`));
    if (layout) return layout;
  }

  throw new Error(
    `Could not locate Unreal Engine for EngineAssociation '${engineAssociation}'. ` +
    `Pass --editor-cmd <path-to-UnrealEditor-Cmd.exe>, or re-run Setup.bat in your engine source tree to refresh the registry.`
  );
}

/**
 * Thin wrapper around `resolveEngineLayout` that returns only the editor
 * binary. Preserves the existing call signature used by `unreal setup`.
 */
export function resolveEditorCmd(explicitPath: string | undefined, engineAssociation: string): string {
  return resolveEngineLayout(engineAssociation, explicitPath).editorCmd;
}

// ─── Plugin installation ───────────────────────────────────────────

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export interface UnrealPluginInstallResult {
  pluginDest: string;
  sharedConfigPath: string;
  localConfigPath: string;
  editorCmd: string;
  projectPath: string;
  projectName: string;
}

/**
 * Create a junction from Plugins/GitNexusUnreal to the plugin source and write both config layers.
 * Throws on any error so callers can handle/display it.
 */
export async function installUnrealPlugin(options: {
  projectRoot: string;
  editorCmd: string;
  uprojectPath: string;
  force?: boolean;
}): Promise<UnrealPluginInstallResult> {
  const { projectRoot, editorCmd, uprojectPath, force } = options;
  const projectName = path.basename(uprojectPath, '.uproject');

  const pluginDest = path.join(projectRoot, 'Plugins', 'GitNexusUnreal');
  const gitnexusDir = path.join(projectRoot, '.gitnexus');
  const unrealDir = path.join(gitnexusDir, 'unreal');
  const localConfigPath = path.join(unrealDir, 'config.json');
  const sharedConfigPath = path.join(projectRoot, '.gitnexus-unreal.json');

  // Guard against re-installation without --force
  const pluginExists = await fs.stat(pluginDest).then(s => s.isDirectory()).catch(() => false);
  const configExists = await fs.stat(localConfigPath).then(s => s.isFile()).catch(() => false)
    || await fs.stat(sharedConfigPath).then(s => s.isFile()).catch(() => false);

  if ((pluginExists || configExists) && !force) {
    throw new Error(
      `Plugin or config already exists in ${projectRoot}. Use --force to overwrite.`
    );
  }

  // Resolve plugin source and create junction (no copy)
  const pluginSource = resolvePluginSource();

  if (pluginExists) {
    await fs.rm(pluginDest, { recursive: true, force: true });
  }
  await fs.mkdir(path.join(projectRoot, 'Plugins'), { recursive: true });
  await fs.symlink(pluginSource, pluginDest, 'junction');

  // Write shared config (.gitnexus-unreal.json — committable, no machine-specific values)
  let existingShared: Record<string, unknown> = {};
  let existingLocal: Record<string, unknown> = {};
  try { existingShared = JSON.parse(await fs.readFile(sharedConfigPath, 'utf-8')); } catch { /* fresh */ }
  try { existingLocal = JSON.parse(await fs.readFile(localConfigPath, 'utf-8')); } catch { /* fresh */ }

  const cliVersion = getCliVersion();
  const sharedConfig = {
    commandlet: 'GitNexusBlueprintAnalyzer',
    timeout_ms: 300000,
    ...existingShared,
    installed_version: cliVersion,
    plugin_source: pluginSource,
  };
  await fs.writeFile(sharedConfigPath, JSON.stringify(sharedConfig, null, 2) + '\n', 'utf-8');

  // Write local config (.gitnexus/unreal/config.json — gitignored, machine-specific)
  await fs.mkdir(unrealDir, { recursive: true });
  const localConfig = {
    ...existingLocal,
    editor_cmd: editorCmd.replace(/\\/g, '/'),
    project_path: uprojectPath.replace(/\\/g, '/'),
  };
  await fs.writeFile(localConfigPath, JSON.stringify(localConfig, null, 2) + '\n', 'utf-8');

  return { pluginDest, sharedConfigPath, localConfigPath, editorCmd, projectPath: uprojectPath, projectName };
}

// ─── Update ───────────────────────────────────────────────────────

export interface UnrealPluginUpdateResult {
  previousVersion: string | undefined;
  newVersion: string;
  pluginSource: string;
  junctionRecreated: boolean;
}

/**
 * Update the plugin junction and version stamp. Preserves existing config.
 * After calling this, the editor target must be rebuilt.
 */
export async function updateUnrealPlugin(options: {
  projectRoot: string;
}): Promise<UnrealPluginUpdateResult> {
  const { projectRoot } = options;
  const pluginDest = path.join(projectRoot, 'Plugins', 'GitNexusUnreal');
  const sharedConfigPath = path.join(projectRoot, '.gitnexus-unreal.json');

  // Read existing shared config
  let existingShared: Record<string, unknown> = {};
  try { existingShared = JSON.parse(await fs.readFile(sharedConfigPath, 'utf-8')); } catch { /* fresh */ }
  const previousVersion = existingShared.installed_version as string | undefined;

  // Resolve current plugin source
  const pluginSource = resolvePluginSource();
  const cliVersion = getCliVersion();

  // Check if junction needs to be recreated
  let junctionRecreated = false;
  const destExists = await fs.stat(pluginDest).catch(() => null);
  if (destExists) {
    // Check if it's a junction pointing to the right place
    try {
      const currentTarget = await fs.readlink(pluginDest);
      if (path.resolve(currentTarget) !== pluginSource) {
        await fs.rm(pluginDest, { recursive: true, force: true });
        await fs.symlink(pluginSource, pluginDest, 'junction');
        junctionRecreated = true;
      }
    } catch {
      // Not a junction (old-style copy) — replace with junction
      await fs.rm(pluginDest, { recursive: true, force: true });
      await fs.symlink(pluginSource, pluginDest, 'junction');
      junctionRecreated = true;
    }
  } else {
    await fs.mkdir(path.join(projectRoot, 'Plugins'), { recursive: true });
    await fs.symlink(pluginSource, pluginDest, 'junction');
    junctionRecreated = true;
  }

  // Update version stamp in shared config (preserve all other fields)
  existingShared.installed_version = cliVersion;
  existingShared.plugin_source = pluginSource;
  await fs.writeFile(sharedConfigPath, JSON.stringify(existingShared, null, 2) + '\n', 'utf-8');

  return { previousVersion, newVersion: cliVersion, pluginSource, junctionRecreated };
}

// ─── Remove ───────────────────────────────────────────────────────

export interface UnrealPluginRemoveResult {
  removed: string[];
}

/**
 * Remove the plugin junction, configs, and manifests from a target UE project.
 * Only removes the junction link — the source files are untouched.
 */
export async function removeUnrealPlugin(options: {
  projectRoot: string;
  keepConfig?: boolean;
}): Promise<UnrealPluginRemoveResult> {
  const { projectRoot, keepConfig } = options;
  const removed: string[] = [];

  // 1. Remove plugin (junction or directory)
  const pluginDest = path.join(projectRoot, 'Plugins', 'GitNexusUnreal');
  const pluginStat = await fs.lstat(pluginDest).catch(() => null);
  if (pluginStat) {
    // fs.rm handles both junctions and real directories
    await fs.rm(pluginDest, { recursive: true, force: true });
    removed.push(pluginDest);
  }

  // 2. Remove .gitnexus/unreal/ (local config, manifest, temp files)
  const unrealStorageDir = path.join(projectRoot, '.gitnexus', 'unreal');
  if (await fs.stat(unrealStorageDir).catch(() => null)) {
    await fs.rm(unrealStorageDir, { recursive: true, force: true });
    removed.push(unrealStorageDir);
  }

  // 3. Remove shared config (unless --keep-config)
  if (!keepConfig) {
    const sharedConfigPath = path.join(projectRoot, '.gitnexus-unreal.json');
    if (await fs.stat(sharedConfigPath).catch(() => null)) {
      await fs.rm(sharedConfigPath);
      removed.push(sharedConfigPath);
    }
  }

  // 4. Clean up empty .gitnexus/ directory
  const gitnexusDir = path.join(projectRoot, '.gitnexus');
  try {
    const entries = await fs.readdir(gitnexusDir);
    if (entries.length === 0) {
      await fs.rmdir(gitnexusDir);
      removed.push(gitnexusDir);
    }
  } catch { /* not present or not empty */ }

  return { removed };
}

// ─── UBT build ────────────────────────────────────────────────────

/**
 * Invoke UnrealBuildTool via Build.bat to compile the editor target.
 * Streams build output directly to the terminal (stdio: 'inherit').
 *
 * Callers must pass an engine root that has already been validated (typically
 * via `resolveEngineLayout`). This function re-probes the layout to resolve
 * Build.bat so the two supported installs (standard + Sipher-nested) Just Work.
 */
export async function buildUnrealPlugin(
  engineRoot: string,
  projectName: string,
  uprojectPath: string
): Promise<void> {
  const layout = probeEngineLayout(engineRoot);
  if (!layout) {
    throw new Error(
      `No valid Unreal Engine layout found under "${engineRoot}". `
      + `Expected UnrealEditor-Cmd.exe and Build.bat inside Engine/.`
    );
  }

  const target = `${projectName}Editor`;
  const args = [target, 'Win64', 'Development', uprojectPath, '-WaitMutex'];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('cmd', ['/c', layout.buildBat, ...args], { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Build failed with exit code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}
