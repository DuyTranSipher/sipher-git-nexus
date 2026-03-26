import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ensureUnrealStorage, saveUnrealAssetManifest } from './config.js';
import type {
  ExpandBlueprintChainResult,
  FindNativeBlueprintReferencesResult,
  NativeFunctionTarget,
  SyncUnrealAssetManifestResult,
  UnrealAssetManifest,
  UnrealAnalyzerExpandChainResponse,
  UnrealAnalyzerFindRefsResponse,
  UnrealBlueprintCandidate,
  UnrealConfig,
  UnrealStoragePaths,
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

export async function syncUnrealAssetManifest(
  storagePath: string,
  config: UnrealConfig,
): Promise<SyncUnrealAssetManifestResult> {
  const unrealPaths = await ensureUnrealStorage(storagePath);
  const { outputPath } = requestPaths(unrealPaths);
  const args = buildBaseArgs(config, 'SyncAssets', outputPath);

  try {
    const { stdout } = await runCommand(config, 'SyncAssets', args);
    const manifest = await readOutputJson<UnrealAssetManifest>(outputPath, stdout);
    const manifestPath = await saveUnrealAssetManifest(storagePath, manifest);
    return {
      status: 'success',
      manifest_path: manifestPath,
      asset_count: manifest.assets.length,
      generated_at: manifest.generated_at,
      warnings: [],
    };
  } catch (error: any) {
    // UE may exit non-zero due to Blueprint compilation warnings even though
    // the commandlet completed and wrote valid output. Try reading the file first.
    try {
      const stdout = error?.stdout ? String(error.stdout).trim() : '';
      const manifest = await readOutputJson<UnrealAssetManifest>(outputPath, stdout);
      if (manifest && Array.isArray(manifest.assets) && manifest.assets.length > 0) {
        const manifestPath = await saveUnrealAssetManifest(storagePath, manifest);
        return {
          status: 'success',
          manifest_path: manifestPath,
          asset_count: manifest.assets.length,
          generated_at: manifest.generated_at,
          warnings: ['UE exited with non-zero code (likely Blueprint compilation warnings)'],
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
}
