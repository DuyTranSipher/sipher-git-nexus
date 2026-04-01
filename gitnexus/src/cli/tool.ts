/**
 * Direct CLI Tool Commands
 * 
 * Exposes GitNexus tools (query, context, impact, cypher) as direct CLI commands.
 * Bypasses MCP entirely — invokes LocalBackend directly for minimal overhead.
 * 
 * Usage:
 *   gitnexus query "authentication flow"
 *   gitnexus context --name "validateUser"
 *   gitnexus impact --target "AuthService" --direction upstream
 *   gitnexus cypher "MATCH (n:Function) RETURN n.name LIMIT 10"
 *   gitnexus unreal-find-refs "ALyraWeaponSpawner::GetPickupInstigator"
 * 
 * Note: Output goes to stdout via fs.writeSync(fd 1), bypassing LadybugDB's
 * native module which captures the Node.js process.stdout stream during init.
 * See the output() function for details (#324).
 */

import { writeSync } from 'node:fs';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { withUnrealProgress } from './unreal-progress.js';

const isUnrealError = (r: any) => r?.status === 'error' || r?.error != null;

let _backend: LocalBackend | null = null;

async function getBackend(): Promise<LocalBackend> {
  if (_backend) return _backend;
  _backend = new LocalBackend();
  const ok = await _backend.init();
  if (!ok) {
    console.error('GitNexus: No indexed repositories found. Run: gitnexus analyze');
    process.exit(1);
  }
  return _backend;
}

/**
 * Write tool output to stdout using low-level fd write.
 *
 * LadybugDB's native module captures Node.js process.stdout during init,
 * but the underlying OS file descriptor 1 (stdout) remains intact.
 * By using fs.writeSync(1, ...) we bypass the Node.js stream layer
 * and write directly to the real stdout fd (#324).
 *
 * Falls back to stderr if the fd write fails (e.g., broken pipe).
 */
function output(data: any): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  try {
    writeSync(1, text + '\n');
  } catch (err: any) {
    if (err?.code === 'EPIPE') {
      // Consumer closed the pipe (e.g., `gitnexus cypher ... | head -1`)
      // Exit cleanly per Unix convention
      process.exit(0);
    }
    // Fallback: stderr (previous behavior, works on all platforms)
    process.stderr.write(text + '\n');
  }
}

export async function queryCommand(queryText: string, options?: {
  repo?: string;
  context?: string;
  goal?: string;
  limit?: string;
  content?: boolean;
}): Promise<void> {
  if (!queryText?.trim()) {
    console.error('Usage: gitnexus query <search_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('query', {
    query: queryText,
    task_context: options?.context,
    goal: options?.goal,
    limit: options?.limit ? parseInt(options.limit) : undefined,
    include_content: options?.content ?? false,
    repo: options?.repo,
  });
  output(result);
}

export async function contextCommand(name: string, options?: {
  repo?: string;
  file?: string;
  uid?: string;
  content?: boolean;
}): Promise<void> {
  if (!name?.trim() && !options?.uid) {
    console.error('Usage: gitnexus context <symbol_name> [--uid <uid>] [--file <path>]');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('context', {
    name: name || undefined,
    uid: options?.uid,
    file_path: options?.file,
    include_content: options?.content ?? false,
    repo: options?.repo,
  });
  output(result);
}

export async function impactCommand(target: string, options?: {
  direction?: string;
  repo?: string;
  depth?: string;
  includeTests?: boolean;
}): Promise<void> {
  if (!target?.trim()) {
    console.error('Usage: gitnexus impact <symbol_name> [--direction upstream|downstream]');
    process.exit(1);
  }

  try {
    const backend = await getBackend();
    const result = await backend.callTool('impact', {
      target,
      direction: options?.direction || 'upstream',
      maxDepth: options?.depth ? parseInt(options.depth, 10) : undefined,
      includeTests: options?.includeTests ?? false,
      repo: options?.repo,
    });
    output(result);
  } catch (err: unknown) {
    // Belt-and-suspenders: catch infrastructure failures (getBackend, callTool transport)
    // The backend's impact() already returns structured errors for graph query failures
    output({
      error: (err instanceof Error ? err.message : String(err)) || 'Impact analysis failed unexpectedly',
      target: { name: target },
      direction: options?.direction || 'upstream',
      suggestion: 'Try reducing --depth or using gitnexus context <symbol> as a fallback',
    });
    process.exit(1);
  }
}

export async function cypherCommand(query: string, options?: {
  repo?: string;
}): Promise<void> {
  if (!query?.trim()) {
    console.error('Usage: gitnexus cypher <cypher_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('cypher', {
    query,
    repo: options?.repo,
  });
  output(result);
}

export async function syncUnrealAssetManifestCommand(options?: {
  repo?: string;
  deep?: boolean;
}): Promise<void> {
  const backend = await getBackend();
  const mode = options?.deep ? 'deep' : 'metadata';
  const result = await withUnrealProgress(
    () => backend.callTool('sync_unreal_asset_manifest', { repo: options?.repo, deep: options?.deep }),
    { phaseLabel: `Syncing Unreal asset manifest (${mode} mode)`, successLabel: 'Manifest synced', failLabel: 'Manifest sync failed', isError: isUnrealError },
  );
  if (result?.status === 'error') {
    console.error(`\n  Error: ${result.error}\n`);
    process.exit(1);
  }
  if (result?.asset_count != null) {
    let summary = `  ${result.asset_count.toLocaleString()} Blueprint assets indexed (${mode} mode)`;
    if (result.skipped_count != null && result.skipped_count > 0) {
      summary += ` — ${result.new_count ?? 0} new, ${result.skipped_count} skipped`;
    }
    console.log(summary);
    if (result.manifest_path) console.log(`  ${result.manifest_path}`);
  }
  output(result);
}

export async function findNativeBlueprintReferencesCommand(functionName: string, options?: {
  repo?: string;
  className?: string;
  file?: string;
  uid?: string;
  refreshManifest?: boolean;
  maxCandidates?: string;
}): Promise<void> {
  if (!functionName?.trim() && !options?.uid) {
    console.error('Usage: gitnexus unreal-find-refs <Class::Function> [--uid <uid>]');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await withUnrealProgress(
    () => backend.callTool('find_native_blueprint_references', {
      function: functionName || undefined,
      symbol_uid: options?.uid,
      class_name: options?.className,
      file_path: options?.file,
      refresh_manifest: options?.refreshManifest ?? false,
      max_candidates: options?.maxCandidates ? parseInt(options.maxCandidates, 10) : undefined,
      repo: options?.repo,
    }),
    { phaseLabel: 'Scanning Blueprints for native references', successLabel: 'Blueprint scan complete', failLabel: 'Blueprint scan failed', isError: isUnrealError },
  );
  if (result?.status === 'error') {
    console.error(`\n  Error: ${result.error}\n`);
    process.exit(1);
  }
  output(result);
}

export async function expandBlueprintChainCommand(assetPath: string, chainAnchorId: string, options?: {
  repo?: string;
  direction?: 'upstream' | 'downstream';
  depth?: string;
}): Promise<void> {
  if (!assetPath?.trim() || !chainAnchorId?.trim()) {
    console.error('Usage: gitnexus unreal-expand-chain <asset_path> <chain_anchor_id>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await withUnrealProgress(
    () => backend.callTool('expand_blueprint_chain', {
      asset_path: assetPath,
      chain_anchor_id: chainAnchorId,
      direction: options?.direction || 'downstream',
      max_depth: options?.depth ? parseInt(options.depth, 10) : undefined,
      repo: options?.repo,
    }),
    { phaseLabel: 'Expanding Blueprint chain', successLabel: 'Chain expanded', failLabel: 'Chain expansion failed', isError: isUnrealError },
  );
  if (result?.status === 'error') {
    console.error(`\n  Error: ${result.error}\n`);
    process.exit(1);
  }
  output(result);
}

export async function findBlueprintsDerivedFromNativeClassCommand(className: string, options?: {
  repo?: string;
  refreshManifest?: boolean;
  maxResults?: string;
}): Promise<void> {
  if (!className?.trim()) {
    console.error('Usage: gitnexus unreal-derived-blueprints <class_name>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await withUnrealProgress(
    () => backend.callTool('find_blueprints_derived_from_native_class', {
      class_name: className,
      refresh_manifest: options?.refreshManifest ?? false,
      max_results: options?.maxResults ? parseInt(options.maxResults, 10) : undefined,
      repo: options?.repo,
    }),
    { phaseLabel: 'Finding derived Blueprints', successLabel: 'Derived Blueprint search complete', failLabel: 'Derived Blueprint search failed', isError: isUnrealError },
  );
  if (result?.status === 'error') {
    console.error(`\n  Error: ${result.error}\n`);
    process.exit(1);
  }
  output(result);
}
