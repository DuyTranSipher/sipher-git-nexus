import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ensureUnrealStorage, loadUnrealAssetManifest, saveUnrealAssetManifest } from './config.js';
import { loadIgnoreRules } from '../config/ignore-service.js';
import type {
  ExpandBlueprintChainResult,
  FindNativeBlueprintReferencesResult,
  NativeFunctionTarget,
  SyncUnrealAssetManifestResult,
  UnrealAssetManifest,
  UnrealAssetManifestAsset,
  UnrealAnalyzerExpandChainResponse,
  UnrealAnalyzerFindRefsResponse,
  UnrealBlueprintCandidate,
  UnrealConfig,
  UnrealStoragePaths,
  UnrealSyncCommandletResponse,
} from './types.js';

const execFileAsync = promisify(execFile);

type AnalyzerOperation = 'SyncAssets' | 'FindNativeBlueprintReferences' | 'ExpandBlueprintChain';

function buildBaseArgs(config: UnrealConfig, operation: AnalyzerOperation, outputPath: string): string[] {
  return [
    config.project_path,
    `-run=${config.commandlet || 'GitNexusBlueprintAnalyzer'}`,
    `-Operation=${operation}`,
    `-OutputJson=${outputPath}`,
    '-unattended',
    '-nop4',
    '-nosplash',
    '-nullrhi',
    ...(config.extra_args || []),
  ];
}

function requestPaths(paths: UnrealStoragePaths): { requestPath: string; outputPath: string } {
  const requestId = randomUUID();
  return {
    requestPath: path.join(paths.requests_dir, `${requestId}.json`),
    outputPath: path.join(paths.outputs_dir, `${requestId}.json`),
  };
}

async function runCommand(
  config: UnrealConfig,
  operation: AnalyzerOperation,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(config.editor_cmd, args, {
    cwd: config.working_directory,
    timeout: config.timeout_ms || 300000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function readUELogErrors(config: UnrealConfig): Promise<string> {
  try {
    const projectDir = path.dirname(config.project_path);
    const projectName = path.basename(config.project_path, '.uproject');
    const logPath = path.join(projectDir, 'Saved', 'Logs', `${projectName}.log`);
    const content = await fs.readFile(logPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const stripped = (l: string) => l.replace(/^\[.*?\]\[\s*\d+\]/, '');
    // Skip callstack lines, driver errors, and empty error lines
    const isNoise = (l: string) => {
      const s = stripped(l);
      return /^LogWindows.*Failed to get driver/i.test(s)
        || /\[Callstack\]/i.test(s)
        || /^LogWindows: Error:\s*$/i.test(s)
        || /^LogWindows: Error: ===/.test(s)
        || /^LogWindows: Error: Fatal error!/i.test(s);
    };
    const errorLines = lines.filter(l =>
      /\bError\b/i.test(l) && !isNoise(l)
    );
    if (errorLines.length === 0) return '';
    return 'UE Log errors:\n' + errorLines.slice(-10).join('\n');
  } catch {
    return '';
  }
}

async function readOutputJson<T>(outputPath: string, stdout: string): Promise<T> {
  try {
    const raw = await fs.readFile(outputPath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return JSON.parse(stdout) as T;
  }
}

interface FilterPrefixes {
  include_prefixes: string[];
  exclude_prefixes: string[];
  include_patterns: string[];
  exclude_patterns: string[];
}

/** Returns true if the value should be treated as a glob or regex pattern rather than a plain prefix. */
function isGlobOrRegex(s: string): boolean {
  return s.startsWith('regex:') || /[*?[]/.test(s);
}

/**
 * Normalize a path to an Unreal package path prefix.
 * Accepts both filesystem paths (Content/X, Plugins/X) and Unreal paths (/Game/X).
 */
function toUnrealPrefix(p: string): string {
  // Preserve regex patterns — do not transform the expression
  if (p.startsWith('regex:')) return p;
  // Strip trailing slashes
  const cleaned = p.replace(/\/+$/, '');
  // Already an Unreal package path
  if (cleaned.startsWith('/')) return cleaned;
  // Content/X → /Game/X
  if (cleaned.startsWith('Content/') || cleaned.startsWith('Content\\')) {
    return '/Game/' + cleaned.slice('Content/'.length);
  }
  // Plugins/X/Content/Y → /X/Y  or  Plugins/X → /X
  if (cleaned.startsWith('Plugins/') || cleaned.startsWith('Plugins\\')) {
    const rest = cleaned.slice('Plugins/'.length);
    const contentIdx = rest.indexOf('/Content/');
    if (contentIdx >= 0) {
      const pluginName = rest.slice(0, contentIdx);
      const inner = rest.slice(contentIdx + '/Content/'.length);
      return `/${pluginName}/${inner}`;
    }
    return '/' + rest;
  }
  // Fallback: assume it's a /Game/ relative path
  return '/Game/' + cleaned;
}

/**
 * Build include/exclude prefix filters for the Unreal commandlet.
 * Merges config `include_paths`/`exclude_paths` with .gitnexusignore patterns,
 * mapping filesystem patterns to Unreal asset path prefixes.
 */
async function buildFilterPrefixes(
  repoPath: string | undefined,
  config: UnrealConfig,
): Promise<FilterPrefixes> {
  const include_prefixes: string[] = [];
  const exclude_prefixes: string[] = [];
  const include_patterns: string[] = [];
  const exclude_patterns: string[] = [];

  // Add explicit include_paths (whitelist) — route to prefix or pattern bucket
  if (config.include_paths && Array.isArray(config.include_paths)) {
    for (const p of config.include_paths) {
      const converted = toUnrealPrefix(p);
      (isGlobOrRegex(converted) ? include_patterns : include_prefixes).push(converted);
    }
  }

  // Add explicit exclude_paths — route to prefix or pattern bucket
  if (config.exclude_paths && Array.isArray(config.exclude_paths)) {
    for (const p of config.exclude_paths) {
      const converted = toUnrealPrefix(p);
      (isGlobOrRegex(converted) ? exclude_patterns : exclude_prefixes).push(converted);
    }
  }

  // Derive exclude prefixes from .gitnexusignore patterns
  if (repoPath) {
    const ig = await loadIgnoreRules(repoPath);
    if (ig) {
      const projectDir = path.dirname(config.project_path);
      try {
        const contentDir = path.join(projectDir, 'Content');
        const entries = await fs.readdir(contentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const relPath = `Content/${entry.name}`;
            if (ig.ignores(relPath) || ig.ignores(relPath + '/')) {
              exclude_prefixes.push(`/Game/${entry.name}`);
            }
          }
        }
      } catch { /* Content dir might not exist */ }

      try {
        const pluginsDir = path.join(projectDir, 'Plugins');
        const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const relPath = `Plugins/${entry.name}`;
            if (ig.ignores(relPath) || ig.ignores(relPath + '/')) {
              exclude_prefixes.push(`/${entry.name}`);
            }
          }
        }
      } catch { /* Plugins dir might not exist */ }
    }
  }

  return { include_prefixes, exclude_prefixes, include_patterns, exclude_patterns };
}

export async function syncUnrealAssetManifest(
  storagePath: string,
  config: UnrealConfig,
  repoPath?: string,
  deep?: boolean,
): Promise<SyncUnrealAssetManifestResult> {
  const unrealPaths = await ensureUnrealStorage(storagePath);
  const { outputPath } = requestPaths(unrealPaths);
  const args = buildBaseArgs(config, 'SyncAssets', outputPath);

  // Pass scan mode: metadata (default, zero loading) or deep (full Blueprint loading)
  args.push(`-Mode=${deep ? 'deep' : 'metadata'}`);

  // Incremental deep sync: load existing manifest to skip unchanged assets
  let oldAssetsByPath: Map<string, UnrealAssetManifestAsset> | undefined;
  if (deep) {
    const existing = await loadUnrealAssetManifest(storagePath);
    if (existing && existing.assets.length > 0) {
      oldAssetsByPath = new Map(existing.assets.map(a => [a.asset_path, a]));
      // Build known_assets map: { asset_path: file_modified_at } for mtime-based change detection
      const knownAssets: Record<string, string> = {};
      for (const asset of existing.assets) {
        if (asset.file_modified_at) {
          knownAssets[asset.asset_path] = asset.file_modified_at;
        }
      }
      const knownJsonPath = path.join(unrealPaths.requests_dir, `known-${randomUUID()}.json`);
      await fs.writeFile(knownJsonPath, JSON.stringify({ known_assets: knownAssets }), 'utf-8');
      args.push(`-KnownAssetsJson=${knownJsonPath}`);
    }
  }

  // Build and pass filter prefixes (include + exclude)
  const filters = await buildFilterPrefixes(repoPath, config);
  if (filters.include_prefixes.length > 0 || filters.exclude_prefixes.length > 0 ||
      filters.include_patterns.length > 0 || filters.exclude_patterns.length > 0) {
    const filterJsonPath = path.join(unrealPaths.requests_dir, `filter-${randomUUID()}.json`);
    await fs.writeFile(filterJsonPath, JSON.stringify(filters), 'utf-8');
    args.push(`-FilterJson=${filterJsonPath}`);
  }

  try {
    const { stdout } = await runCommand(config, 'SyncAssets', args);
    const response = await readOutputJson<UnrealSyncCommandletResponse>(outputPath, stdout);

    // Merge old entries for skipped assets with newly-processed assets
    const manifest = mergeDeepManifest(response, oldAssetsByPath);
    const manifestPath = await saveUnrealAssetManifest(storagePath, manifest);

    const skippedCount = response.skipped_paths?.length ?? 0;
    const newCount = response.assets.length;
    return {
      status: 'success',
      manifest_path: manifestPath,
      asset_count: manifest.assets.length,
      generated_at: manifest.generated_at,
      warnings: [],
      ...(skippedCount > 0 ? { skipped_count: skippedCount, new_count: newCount } : {}),
    };
  } catch (error: any) {
    // UE may exit non-zero due to Blueprint compilation warnings even though
    // the commandlet completed and wrote valid output. Try reading the file first.
    try {
      const stdout = error?.stdout ? String(error.stdout).trim() : '';
      const response = await readOutputJson<UnrealSyncCommandletResponse>(outputPath, stdout);
      if (response && Array.isArray(response.assets) && response.assets.length > 0) {
        const manifest = mergeDeepManifest(response, oldAssetsByPath);
        const manifestPath = await saveUnrealAssetManifest(storagePath, manifest);
        const skippedCount = response.skipped_paths?.length ?? 0;
        const newCount = response.assets.length;
        return {
          status: 'success',
          manifest_path: manifestPath,
          asset_count: manifest.assets.length,
          generated_at: manifest.generated_at,
          warnings: ['UE exited with non-zero code (likely Blueprint compilation warnings)'],
          ...(skippedCount > 0 ? { skipped_count: skippedCount, new_count: newCount } : {}),
        };
      }
    } catch { /* output file not readable, fall through to error */ }

    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    const stdout = error?.stdout ? String(error.stdout).trim() : '';
    const msg = error instanceof Error ? error.message : String(error);
    const ueLog = await readUELogErrors(config);
    const details = [msg, stderr && `stderr: ${stderr}`, stdout && `stdout: ${stdout}`, ueLog]
      .filter(Boolean)
      .join('\n');
    return {
      status: 'error',
      error: details,
    };
  }
}

/**
 * Merge commandlet response with old manifest entries for incrementally-skipped assets.
 * New assets come from the commandlet; skipped assets reuse their old manifest entry.
 * Assets in the old manifest but not in the commandlet output (neither assets nor skipped_paths) are deleted.
 */
function mergeDeepManifest(
  response: UnrealSyncCommandletResponse,
  oldAssets: Map<string, UnrealAssetManifestAsset> | undefined,
): UnrealAssetManifest {
  const merged = [...response.assets];
  if (oldAssets && response.skipped_paths) {
    for (const skippedPath of response.skipped_paths) {
      const oldEntry = oldAssets.get(skippedPath);
      if (oldEntry) {
        merged.push(oldEntry);
      }
    }
  }
  return {
    version: response.version,
    generated_at: response.generated_at,
    project_path: response.project_path,
    mode: response.mode,
    assets: merged,
  };
}

export async function findNativeBlueprintReferences(
  storagePath: string,
  config: UnrealConfig,
  target: NativeFunctionTarget,
  candidateAssets: UnrealBlueprintCandidate[],
  manifestPath?: string,
): Promise<FindNativeBlueprintReferencesResult> {
  const unrealPaths = await ensureUnrealStorage(storagePath);
  const { requestPath, outputPath } = requestPaths(unrealPaths);
  await fs.writeFile(requestPath, JSON.stringify({ candidate_assets: candidateAssets }, null, 2), 'utf-8');

  const args = [
    ...buildBaseArgs(config, 'FindNativeBlueprintReferences', outputPath),
    `-TargetSymbolKey=${target.symbol_key}`,
    `-TargetFunction=${target.symbol_name}`,
    ...(target.class_name ? [`-TargetClass=${target.class_name}`] : []),
    `-CandidatesJson=${requestPath}`,
  ];

  try {
    const { stdout } = await runCommand(config, 'FindNativeBlueprintReferences', args);
    const response = await readOutputJson<UnrealAnalyzerFindRefsResponse>(outputPath, stdout);

    return {
      target_function: {
        ...target,
        ...(response.target_function || {}),
      },
      candidates_scanned: response.candidates_scanned ?? candidateAssets.length,
      candidate_assets: candidateAssets,
      confirmed_references: response.confirmed_references || [],
      manifest_path: manifestPath,
      warnings: response.warnings || [],
    };
  } catch (error: any) {
    // UE may exit non-zero due to Blueprint compilation warnings even though
    // the commandlet completed and wrote valid output. Try reading the file first.
    try {
      const stdout = error?.stdout ? String(error.stdout).trim() : '';
      const response = await readOutputJson<UnrealAnalyzerFindRefsResponse>(outputPath, stdout);
      if (response && Array.isArray(response.confirmed_references)) {
        return {
          target_function: {
            ...target,
            ...(response.target_function || {}),
          },
          candidates_scanned: response.candidates_scanned ?? candidateAssets.length,
          candidate_assets: candidateAssets,
          confirmed_references: response.confirmed_references,
          manifest_path: manifestPath,
          warnings: [...(response.warnings || []), 'UE exited with non-zero code (likely Blueprint compilation warnings)'],
        };
      }
    } catch { /* output file not readable, fall through to error */ }

    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    const stdout = error?.stdout ? String(error.stdout).trim() : '';
    const msg = error instanceof Error ? error.message : String(error);
    const ueLog = await readUELogErrors(config);
    const details = [msg, stderr && `stderr: ${stderr}`, stdout && `stdout: ${stdout}`, ueLog]
      .filter(Boolean)
      .join('\n');
    return {
      status: 'error',
      error: details,
      target_function: target,
      candidates_scanned: candidateAssets.length,
      candidate_assets: candidateAssets,
      confirmed_references: [],
      manifest_path: manifestPath,
      warnings: [],
    };
  }
}

export async function expandBlueprintChain(
  storagePath: string,
  config: UnrealConfig,
  assetPath: string,
  chainAnchorId: string,
  direction: 'upstream' | 'downstream',
  maxDepth: number,
): Promise<ExpandBlueprintChainResult> {
  const unrealPaths = await ensureUnrealStorage(storagePath);
  const { outputPath } = requestPaths(unrealPaths);
  const args = [
    ...buildBaseArgs(config, 'ExpandBlueprintChain', outputPath),
    `-AssetPath=${assetPath}`,
    `-ChainAnchorId=${chainAnchorId}`,
    `-Direction=${direction}`,
    `-MaxDepth=${maxDepth}`,
  ];

  try {
    const { stdout } = await runCommand(config, 'ExpandBlueprintChain', args);
    const response = await readOutputJson<UnrealAnalyzerExpandChainResponse>(outputPath, stdout);

    return {
      asset_path: assetPath,
      chain_anchor_id: chainAnchorId,
      direction,
      max_depth: maxDepth,
      nodes: response.nodes || [],
      warnings: response.warnings || [],
    };
  } catch (error: any) {
    // UE may exit non-zero due to Blueprint compilation warnings even though
    // the commandlet completed and wrote valid output. Try reading the file first.
    try {
      const stdout = error?.stdout ? String(error.stdout).trim() : '';
      const response = await readOutputJson<UnrealAnalyzerExpandChainResponse>(outputPath, stdout);
      if (response && Array.isArray(response.nodes)) {
        return {
          asset_path: assetPath,
          chain_anchor_id: chainAnchorId,
          direction,
          max_depth: maxDepth,
          nodes: response.nodes,
          warnings: [...(response.warnings || []), 'UE exited with non-zero code (likely Blueprint compilation warnings)'],
        };
      }
    } catch { /* output file not readable, fall through to error */ }

    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    const stdout = error?.stdout ? String(error.stdout).trim() : '';
    const msg = error instanceof Error ? error.message : String(error);
    const ueLog = await readUELogErrors(config);
    const details = [msg, stderr && `stderr: ${stderr}`, stdout && `stdout: ${stdout}`, ueLog]
      .filter(Boolean)
      .join('\n');
    return {
      status: 'error',
      error: details,
      asset_path: assetPath,
      chain_anchor_id: chainAnchorId,
      direction,
      max_depth: maxDepth,
      nodes: [],
      warnings: [],
    };
  }
}
