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

// ─── Editor command resolution ─────────────────────────────────────

export function resolveEditorCmd(explicitPath: string | undefined, engineAssociation: string): string {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    try {
      fsSync.accessSync(resolved);
    } catch {
      throw new Error(`Editor command not found: ${resolved}`);
    }
    return resolved;
  }

  if (process.platform !== 'win32') {
    throw new Error('Auto-detection of UnrealEditor-Cmd is only supported on Windows. Use --editor-cmd.');
  }

  const tryCandidates = (rootOrExe: string): string | null => {
    const candidates = [
      rootOrExe,
      path.join(rootOrExe, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'),
      path.join(rootOrExe, 'Engine', 'Windows', 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'),
    ];
    for (const c of candidates) {
      try {
        const stat = fsSync.statSync(c);
        if (stat.isFile()) return c;
      } catch { /* next */ }
    }
    return null;
  };

  if (engineAssociation) {
    // Try registry lookup for source builds (GUID engine association)
    try {
      const regQuery = `reg query "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds" /v "${engineAssociation}" 2>nul`;
      const output = execSync(regQuery, { encoding: 'utf-8' });
      const match = output.match(/REG_SZ\s+(.+)/);
      if (match) {
        const found = tryCandidates(match[1].trim());
        if (found) return found;
      }
    } catch { /* registry key not found */ }

    // Try LauncherInstalled.dat (Epic Games Launcher writes this for all engine installs)
    try {
      const launcherDat = path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'EpicGames', 'UnrealEngineLauncher', 'LauncherInstalled.dat'
      );
      const launcher = JSON.parse(fsSync.readFileSync(launcherDat, 'utf-8'));
      if (Array.isArray(launcher.InstallationList)) {
        for (const entry of launcher.InstallationList) {
          if (entry.AppName === `UE_${engineAssociation}` || entry.AppName === engineAssociation) {
            const found = tryCandidates(entry.InstallLocation);
            if (found) return found;
          }
        }
      }
    } catch { /* LauncherInstalled.dat not found or unparseable */ }

    // Try standard install path
    const found = tryCandidates(path.join('C:\\Program Files\\Epic Games', `UE_${engineAssociation}`));
    if (found) return found;
  }

  throw new Error(
    `Could not auto-detect UnrealEditor-Cmd.exe for EngineAssociation '${engineAssociation}'. Use --editor-cmd to specify it.`
  );
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
 * Copy the bundled plugin into the UE project and write both config layers.
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

  // Locate bundled plugin (vendor/ relative to package root)
  const bundledPlugin = path.join(__dirname, '..', '..', 'vendor', 'GitNexusUnreal');
  const bundleExists = await fs.stat(bundledPlugin).then(s => s.isDirectory()).catch(() => false);
  if (!bundleExists) {
    throw new Error('Bundled plugin not found at vendor/GitNexusUnreal. Reinstall the gitnexus package.');
  }

  // Copy plugin
  if (pluginExists) {
    await fs.rm(pluginDest, { recursive: true, force: true });
  }
  await fs.mkdir(path.join(projectRoot, 'Plugins'), { recursive: true });
  await copyDirRecursive(bundledPlugin, pluginDest);

  // Write shared config (.gitnexus-unreal.json — committable, no machine-specific values)
  let existingShared: Record<string, unknown> = {};
  let existingLocal: Record<string, unknown> = {};
  try { existingShared = JSON.parse(await fs.readFile(sharedConfigPath, 'utf-8')); } catch { /* fresh */ }
  try { existingLocal = JSON.parse(await fs.readFile(localConfigPath, 'utf-8')); } catch { /* fresh */ }

  const sharedConfig = {
    commandlet: 'GitNexusBlueprintAnalyzer',
    timeout_ms: 300000,
    ...existingShared,
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

// ─── UBT build ────────────────────────────────────────────────────

/**
 * Invoke UnrealBuildTool via Build.bat to compile the editor target.
 * Streams build output directly to the terminal (stdio: 'inherit').
 */
export async function buildUnrealPlugin(
  editorCmd: string,
  projectName: string,
  uprojectPath: string
): Promise<void> {
  // Derive engine root from editor_cmd path
  // e.g. "C:/Program Files/Epic Games/UE_5.5/Engine/Binaries/Win64/UnrealEditor-Cmd.exe"
  //   →  "C:\Program Files\Epic Games\UE_5.5"
  const normalized = editorCmd.replace(/\//g, '\\');
  const engineBinIdx = normalized.search(/\\Engine\\Binaries\\/i);
  if (engineBinIdx === -1) {
    throw new Error(
      `Cannot derive engine root from editor_cmd: "${editorCmd}". Expected path containing \\Engine\\Binaries\\.`
    );
  }
  const engineRoot = normalized.slice(0, engineBinIdx);
  const buildBat = path.join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat');

  try {
    fsSync.accessSync(buildBat);
  } catch {
    throw new Error(`Build.bat not found at: ${buildBat}`);
  }

  const target = `${projectName}Editor`;
  const args = [target, 'Win64', 'Development', uprojectPath, '-WaitMutex'];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('cmd', ['/c', buildBat, ...args], { stdio: 'inherit' });
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
