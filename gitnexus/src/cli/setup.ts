/**
 * Setup Command
 * 
 * One-time global MCP configuration writer.
 * Detects installed AI editors and writes the appropriate MCP config
 * so the GitNexus MCP server is available in all projects.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { getGlobalDir } from '../storage/repo-manager.js';
import type { UnrealConfig } from '../unreal/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface SetupResult {
  configured: string[];
  skipped: string[];
  errors: string[];
}

/**
 * The MCP server entry for all editors.
 * On Windows, npx must be invoked via cmd /c since it's a .cmd script.
 */
function getMcpEntry() {
  if (process.platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'gitnexus@latest', 'mcp'],
    };
  }
  return {
    command: 'npx',
    args: ['-y', 'gitnexus@latest', 'mcp'],
  };
}

/**
 * Merge gitnexus entry into an existing MCP config JSON object.
 * Returns the updated config.
 */
function mergeMcpConfig(existing: any): any {
  if (!existing || typeof existing !== 'object') {
    existing = {};
  }
  if (!existing.mcpServers || typeof existing.mcpServers !== 'object') {
    existing.mcpServers = {};
  }
  existing.mcpServers.gitnexus = getMcpEntry();
  return existing;
}

/**
 * Try to read a JSON file, returning null if it doesn't exist or is invalid.
 */
async function readJsonFile(filePath: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write JSON to a file, creating parent directories if needed.
 */
async function writeJsonFile(filePath: string, data: any): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Check if a directory exists
 */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ─── Editor-specific setup ─────────────────────────────────────────

async function setupCursor(result: SetupResult): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) {
    result.skipped.push('Cursor (not installed)');
    return;
  }

  const mcpPath = path.join(cursorDir, 'mcp.json');
  try {
    const existing = await readJsonFile(mcpPath);
    const updated = mergeMcpConfig(existing);
    await writeJsonFile(mcpPath, updated);
    result.configured.push('Cursor');
  } catch (err: any) {
    result.errors.push(`Cursor: ${err.message}`);
  }
}

async function setupClaudeCode(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  const hasClaude = await dirExists(claudeDir);

  if (!hasClaude) {
    result.skipped.push('Claude Code (not installed)');
    return;
  }

  // Claude Code uses a JSON settings file at ~/.claude.json or claude mcp add
  console.log('');
  console.log('  Claude Code detected. Run this command to add GitNexus MCP:');
  console.log('');
  console.log('    claude mcp add gitnexus -- npx -y gitnexus mcp');
  console.log('');
  result.configured.push('Claude Code (MCP manual step printed)');
}

/**
 * Install GitNexus skills to ~/.claude/skills/ for Claude Code.
 */
async function installClaudeCodeSkills(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) return;

  const skillsDir = path.join(claudeDir, 'skills');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Claude Code skills (${installed.length} skills → ~/.claude/skills/)`);
    }
  } catch (err: any) {
    result.errors.push(`Claude Code skills: ${err.message}`);
  }
}

/**
 * Install GitNexus hooks to ~/.claude/settings.json for Claude Code.
 * Merges hook config without overwriting existing hooks.
 */
async function installClaudeCodeHooks(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) return;

  const settingsPath = path.join(claudeDir, 'settings.json');

  // Source hooks bundled within the gitnexus package (hooks/claude/)
  const pluginHooksPath = path.join(__dirname, '..', '..', 'hooks', 'claude');

  // Copy unified hook script to ~/.claude/hooks/gitnexus/
  const destHooksDir = path.join(claudeDir, 'hooks', 'gitnexus');

  try {
    await fs.mkdir(destHooksDir, { recursive: true });

    const src = path.join(pluginHooksPath, 'gitnexus-hook.cjs');
    const dest = path.join(destHooksDir, 'gitnexus-hook.cjs');
    try {
      let content = await fs.readFile(src, 'utf-8');
      // Inject resolved CLI path so the copied hook can find the CLI
      // even when it's no longer inside the npm package tree
      const resolvedCli = path.join(__dirname, '..', 'cli', 'index.js');
      const normalizedCli = path.resolve(resolvedCli).replace(/\\/g, '/');
      const jsonCli = JSON.stringify(normalizedCli);
      content = content.replace(
        "let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');",
        `let cliPath = ${jsonCli};`
      );
      await fs.writeFile(dest, content, 'utf-8');
    } catch {
      // Script not found in source — skip
    }

    const hookPath = path.join(destHooksDir, 'gitnexus-hook.cjs').replace(/\\/g, '/');
    const hookCmd = `node "${hookPath.replace(/"/g, '\\"')}"`;

    // Merge hook config into ~/.claude/settings.json
    const existing = await readJsonFile(settingsPath) || {};
    if (!existing.hooks) existing.hooks = {};

    // NOTE: SessionStart hooks are broken on Windows (Claude Code bug #23576).
    // Session context is delivered via CLAUDE.md / skills instead.

    // Helper: add a hook entry if one with 'gitnexus-hook' isn't already registered
    interface HookEntry { hooks?: Array<{ command?: string }> }
    function ensureHookEntry(
      eventName: string,
      matcher: string,
      timeout: number,
      statusMessage: string,
    ) {
      if (!existing.hooks[eventName]) existing.hooks[eventName] = [];
      const hasHook = existing.hooks[eventName].some(
        (h: HookEntry) => h.hooks?.some(hh => hh.command?.includes('gitnexus-hook'))
      );
      if (!hasHook) {
        existing.hooks[eventName].push({
          matcher,
          hooks: [{ type: 'command', command: hookCmd, timeout, statusMessage }],
        });
      }
    }

    ensureHookEntry('PreToolUse', 'Grep|Glob|Bash', 10, 'Enriching with GitNexus graph context...');
    ensureHookEntry('PostToolUse', 'Bash', 10, 'Checking GitNexus index freshness...');

    await writeJsonFile(settingsPath, existing);
    result.configured.push('Claude Code hooks (PreToolUse, PostToolUse)');
  } catch (err: any) {
    result.errors.push(`Claude Code hooks: ${err.message}`);
  }
}

async function setupOpenCode(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) {
    result.skipped.push('OpenCode (not installed)');
    return;
  }

  const configPath = path.join(opencodeDir, 'config.json');
  try {
    const existing = await readJsonFile(configPath);
    const config = existing || {};
    if (!config.mcp) config.mcp = {};
    config.mcp.gitnexus = getMcpEntry();
    await writeJsonFile(configPath, config);
    result.configured.push('OpenCode');
  } catch (err: any) {
    result.errors.push(`OpenCode: ${err.message}`);
  }
}

// ─── Skill Installation ───────────────────────────────────────────

/**
 * Install GitNexus skills to a target directory.
 * Each skill is installed as {targetDir}/gitnexus-{skillName}/SKILL.md
 * following the Agent Skills standard (both Cursor and Claude Code).
 *
 * Supports two source layouts:
 *   - Flat file:  skills/{name}.md           → copied as SKILL.md
 *   - Directory:  skills/{name}/SKILL.md     → copied recursively (includes references/, etc.)
 */
async function installSkillsTo(targetDir: string): Promise<string[]> {
  const installed: string[] = [];
  const skillsRoot = path.join(__dirname, '..', '..', 'skills');

  let flatFiles: string[] = [];
  let dirSkillFiles: string[] = [];
  try {
    [flatFiles, dirSkillFiles] = await Promise.all([
      glob('*.md', { cwd: skillsRoot }),
      glob('*/SKILL.md', { cwd: skillsRoot }),
    ]);
  } catch {
    return [];
  }

  const skillSources = new Map<string, { isDirectory: boolean }>();

  for (const relPath of dirSkillFiles) {
    skillSources.set(path.dirname(relPath), { isDirectory: true });
  }
  for (const relPath of flatFiles) {
    const skillName = path.basename(relPath, '.md');
    if (!skillSources.has(skillName)) {
      skillSources.set(skillName, { isDirectory: false });
    }
  }

  for (const [skillName, source] of skillSources) {
    const skillDir = path.join(targetDir, skillName);

    try {
      if (source.isDirectory) {
        const dirSource = path.join(skillsRoot, skillName);
        await copyDirRecursive(dirSource, skillDir);
        installed.push(skillName);
      } else {
        const flatSource = path.join(skillsRoot, `${skillName}.md`);
        const content = await fs.readFile(flatSource, 'utf-8');
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
        installed.push(skillName);
      }
    } catch {
      // Source skill not found — skip
    }
  }

  return installed;
}

/**
 * Recursively copy a directory tree.
 */
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

/**
 * Install global Cursor skills to ~/.cursor/skills/gitnexus/
 */
async function installCursorSkills(result: SetupResult): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) return;
  
  const skillsDir = path.join(cursorDir, 'skills');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Cursor skills (${installed.length} skills → ~/.cursor/skills/)`);
    }
  } catch (err: any) {
    result.errors.push(`Cursor skills: ${err.message}`);
  }
}

/**
 * Install global OpenCode skills to ~/.config/opencode/skill/gitnexus/
 */
async function installOpenCodeSkills(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) return;
  
  const skillsDir = path.join(opencodeDir, 'skill');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`OpenCode skills (${installed.length} skills → ~/.config/opencode/skill/)`);
    }
  } catch (err: any) {
    result.errors.push(`OpenCode skills: ${err.message}`);
  }
}

// ─── Unreal Engine setup ──────────────────────────────────────────

interface UnrealSetupOptions {
  project?: string;
  editorCmd?: string;
  force?: boolean;
}

async function findUProjectFile(projectRoot: string): Promise<string> {
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

function resolveEditorCmd(explicitPath: string | undefined, engineAssociation: string): string {
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

  // Try registry lookup for source builds (GUID engine association)
  if (engineAssociation) {
    try {
      const regQuery = `reg query "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds" /v "${engineAssociation}" 2>nul`;
      const output = execSync(regQuery, { encoding: 'utf-8' });
      const match = output.match(/REG_SZ\s+(.+)/);
      if (match) {
        const found = tryCandidates(match[1].trim());
        if (found) return found;
      }
    } catch { /* registry key not found */ }

    // Try standard install path
    const found = tryCandidates(path.join('C:\\Program Files\\Epic Games', `UE_${engineAssociation}`));
    if (found) return found;
  }

  throw new Error(
    `Could not auto-detect UnrealEditor-Cmd.exe for EngineAssociation '${engineAssociation}'. Use --editor-cmd to specify it.`
  );
}

async function setupUnreal(options: UnrealSetupOptions, result: SetupResult): Promise<void> {
  const projectRoot = path.resolve(options.project || process.cwd());

  try {
    const stat = await fs.stat(projectRoot);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    result.errors.push(`Unreal: project root not found: ${projectRoot}`);
    return;
  }

  let uprojectPath: string;
  try {
    uprojectPath = await findUProjectFile(projectRoot);
  } catch (err: any) {
    result.errors.push(`Unreal: ${err.message}`);
    return;
  }

  // Read engine association from .uproject
  let engineAssociation = '';
  try {
    const uproject = JSON.parse(await fs.readFile(uprojectPath, 'utf-8'));
    engineAssociation = uproject.EngineAssociation || '';
  } catch (err: any) {
    result.errors.push(`Unreal: failed to read ${path.basename(uprojectPath)}: ${err.message}`);
    return;
  }

  // Resolve editor command
  let editorCmd: string;
  try {
    editorCmd = resolveEditorCmd(options.editorCmd, engineAssociation);
  } catch (err: any) {
    result.errors.push(`Unreal: ${err.message}`);
    return;
  }

  // Paths
  const pluginDest = path.join(projectRoot, 'Plugins', 'GitNexusUnreal');
  const gitnexusDir = path.join(projectRoot, '.gitnexus');
  const unrealDir = path.join(gitnexusDir, 'unreal');
  const configPath = path.join(unrealDir, 'config.json');

  // Check existing installation
  const pluginExists = await dirExists(pluginDest);
  const configExists = await fileExists(configPath);

  if ((pluginExists || configExists) && !options.force) {
    result.errors.push(
      `Unreal: plugin or config already exists in ${projectRoot}. Use --force to overwrite.`
    );
    return;
  }

  // Copy bundled plugin
  const bundledPlugin = path.join(__dirname, '..', '..', 'vendor', 'GitNexusUnreal');
  if (!(await dirExists(bundledPlugin))) {
    result.errors.push('Unreal: bundled plugin not found in vendor/GitNexusUnreal');
    return;
  }

  try {
    if (pluginExists) {
      await fs.rm(pluginDest, { recursive: true, force: true });
    }
    await fs.mkdir(path.join(projectRoot, 'Plugins'), { recursive: true });
    await copyDirRecursive(bundledPlugin, pluginDest);
  } catch (err: any) {
    result.errors.push(`Unreal: failed to copy plugin: ${err.message}`);
    return;
  }

  // Write config
  try {
    await fs.mkdir(unrealDir, { recursive: true });
    const config: UnrealConfig = {
      editor_cmd: editorCmd.replace(/\\/g, '/'),
      project_path: uprojectPath.replace(/\\/g, '/'),
      commandlet: 'GitNexusBlueprintAnalyzer',
      timeout_ms: 300000,
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err: any) {
    result.errors.push(`Unreal: failed to write config: ${err.message}`);
    return;
  }

  result.configured.push(`Unreal plugin → ${pluginDest}`);
  result.configured.push(`Unreal config → ${configPath}`);
  console.log(`    Editor: ${editorCmd}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

// ─── Main command ──────────────────────────────────────────────────

export const setupCommand = async (options: { unreal?: boolean; project?: string; editorCmd?: string; force?: boolean }) => {
  console.log('');
  console.log('  GitNexus Setup');
  console.log('  ==============');
  console.log('');

  // Ensure global directory exists
  const globalDir = getGlobalDir();
  await fs.mkdir(globalDir, { recursive: true });

  const result: SetupResult = {
    configured: [],
    skipped: [],
    errors: [],
  };

  // Detect and configure each editor's MCP
  await setupCursor(result);
  await setupClaudeCode(result);
  await setupOpenCode(result);

  // Install global skills for platforms that support them
  await installClaudeCodeSkills(result);
  await installClaudeCodeHooks(result);
  await installCursorSkills(result);
  await installOpenCodeSkills(result);

  // Unreal Engine plugin setup (optional)
  if (options.unreal) {
    console.log('  Unreal Engine Setup');
    console.log('  -------------------');
    await setupUnreal({ project: options.project, editorCmd: options.editorCmd, force: options.force }, result);
  }

  // Print results
  if (result.configured.length > 0) {
    console.log('  Configured:');
    for (const name of result.configured) {
      console.log(`    + ${name}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('');
    console.log('  Skipped:');
    for (const name of result.skipped) {
      console.log(`    - ${name}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log('  Errors:');
    for (const err of result.errors) {
      console.log(`    ! ${err}`);
    }
  }

  console.log('');
  console.log('  Summary:');
  console.log(`    MCP configured for: ${result.configured.filter(c => !c.includes('skills')).join(', ') || 'none'}`);
  console.log(`    Skills installed to: ${result.configured.filter(c => c.includes('skills')).length > 0 ? result.configured.filter(c => c.includes('skills')).join(', ') : 'none'}`);
  console.log('');
  console.log('  Next steps:');
  console.log('    1. cd into any git repo');
  console.log('    2. Run: gitnexus analyze');
  console.log('    3. Open the repo in your editor — MCP is ready!');
  if (options.unreal) {
    console.log('');
    console.log('  Unreal next steps:');
    console.log('    1. Build your Unreal editor target (so the commandlet compiles)');
    console.log('    2. Run: gitnexus analyze     (index the C++ codebase)');
    console.log('    3. Run: gitnexus unreal-sync  (scan Blueprint assets)');
  }
  console.log('');
};
