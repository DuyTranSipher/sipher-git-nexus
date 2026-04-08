/**
 * Graph Queries for Wiki Generation
 *
 * Encapsulated Cypher queries against the GitNexus knowledge graph.
 * Uses the MCP-style pooled lbug-adapter for connection management.
 */

import { initLbug, executeQuery, closeLbug } from '../../mcp/core/lbug-adapter.js';
import { UE_ASSET_LABELS } from '../../unreal/asset-types.js';

const REPO_ID = '__wiki__';

const extractLabel = (v: unknown): string | undefined =>
  Array.isArray(v) ? v[0] : typeof v === 'string' ? v : undefined;

export interface FileWithExports {
  filePath: string;
  symbols: Array<{ name: string; type: string }>;
}

export interface CallEdge {
  fromFile: string;
  fromName: string;
  toFile: string;
  toName: string;
}

export interface BlueprintAssetInfo {
  assetPath: string;
  name: string;
  label: string;
  assetClass: string;
}

export interface BlueprintEdgeData {
  extends: string[];
  calls: string[];
  imports: string[];
  implements: string[];
  overrides: string[];
  dispatches: string[];
  gameplayTags: string[];
}

export interface ProcessInfo {
  id: string;
  label: string;
  type: string;
  stepCount: number;
  steps: Array<{
    step: number;
    name: string;
    filePath: string;
    type: string;
  }>;
}

/**
 * Initialize the LadybugDB connection for wiki generation.
 */
export async function initWikiDb(lbugPath: string): Promise<void> {
  await initLbug(REPO_ID, lbugPath);
}

/**
 * Close the LadybugDB connection.
 */
export async function closeWikiDb(): Promise<void> {
  await closeLbug(REPO_ID);
}

/**
 * Get all source files with their exported symbol names and types.
 */
export async function getFilesWithExports(): Promise<FileWithExports[]> {
  const rows = await executeQuery(REPO_ID, `
    MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(n)
    WHERE n.isExported = true
    RETURN f.filePath AS filePath, n.name AS name, labels(n) AS type
    ORDER BY f.filePath
  `);

  const fileMap = new Map<string, FileWithExports>();
  for (const row of rows) {
    const fp = row.filePath || row[0];
    const name = row.name || row[1];
    const type = extractLabel(row.type || row[2]);

    let entry = fileMap.get(fp);
    if (!entry) {
      entry = { filePath: fp, symbols: [] };
      fileMap.set(fp, entry);
    }
    entry.symbols.push({ name, type });
  }

  return Array.from(fileMap.values());
}

/**
 * Get all files tracked in the graph (including those with no exports).
 */
export async function getAllFiles(): Promise<string[]> {
  const rows = await executeQuery(REPO_ID, `
    MATCH (f:File)
    RETURN f.filePath AS filePath
    ORDER BY f.filePath
  `);
  return rows.map(r => r.filePath || r[0]);
}

/**
 * Get inter-file call edges (calls between different files).
 */
export async function getInterFileCallEdges(): Promise<CallEdge[]> {
  const rows = await executeQuery(REPO_ID, `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath <> b.filePath
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `);

  return rows.map(r => ({
    fromFile: r.fromFile || r[0],
    fromName: r.fromName || r[1],
    toFile: r.toFile || r[2],
    toName: r.toName || r[3],
  }));
}

/**
 * Get call edges between files within a specific set (intra-module).
 */
export async function getIntraModuleCallEdges(filePaths: string[]): Promise<CallEdge[]> {
  if (filePaths.length === 0) return [];

  const fileList = filePaths.map(f => `'${f.replace(/'/g, "''")}'`).join(', ');
  const rows = await executeQuery(REPO_ID, `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN [${fileList}] AND b.filePath IN [${fileList}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
  `);

  return rows.map(r => ({
    fromFile: r.fromFile || r[0],
    fromName: r.fromName || r[1],
    toFile: r.toFile || r[2],
    toName: r.toName || r[3],
  }));
}

/**
 * Get call edges crossing module boundaries (external calls from/to module files).
 */
export async function getInterModuleCallEdges(filePaths: string[]): Promise<{
  outgoing: CallEdge[];
  incoming: CallEdge[];
}> {
  if (filePaths.length === 0) return { outgoing: [], incoming: [] };

  const fileList = filePaths.map(f => `'${f.replace(/'/g, "''")}'`).join(', ');

  const outRows = await executeQuery(REPO_ID, `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE a.filePath IN [${fileList}] AND NOT b.filePath IN [${fileList}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT 30
  `);

  const inRows = await executeQuery(REPO_ID, `
    MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b)
    WHERE NOT a.filePath IN [${fileList}] AND b.filePath IN [${fileList}]
    RETURN DISTINCT a.filePath AS fromFile, a.name AS fromName,
           b.filePath AS toFile, b.name AS toName
    LIMIT 30
  `);

  return {
    outgoing: outRows.map(r => ({
      fromFile: r.fromFile || r[0],
      fromName: r.fromName || r[1],
      toFile: r.toFile || r[2],
      toName: r.toName || r[3],
    })),
    incoming: inRows.map(r => ({
      fromFile: r.fromFile || r[0],
      fromName: r.fromName || r[1],
      toFile: r.toFile || r[2],
      toName: r.toName || r[3],
    })),
  };
}

/**
 * Get processes (execution flows) that pass through a set of files.
 * Returns top N by step count.
 */
export async function getProcessesForFiles(filePaths: string[], limit = 5): Promise<ProcessInfo[]> {
  if (filePaths.length === 0) return [];

  const fileList = filePaths.map(f => `'${f.replace(/'/g, "''")}'`).join(', ');

  // Find processes that have steps in the given files
  const procRows = await executeQuery(REPO_ID, `
    MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
    WHERE s.filePath IN [${fileList}]
    RETURN DISTINCT p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC
    LIMIT ${limit}
  `);

  const processes: ProcessInfo[] = [];
  for (const row of procRows) {
    const procId = row.id || row[0];
    const label = row.label || row[1] || procId;
    const type = row.type || row[2] || 'unknown';
    const stepCount = row.stepCount || row[3] || 0;

    // Get the full step trace for this process
    const stepRows = await executeQuery(REPO_ID, `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${procId.replace(/'/g, "''")}'})
      RETURN s.name AS name, s.filePath AS filePath, labels(s) AS type, r.step AS step
      ORDER BY r.step
    `);

    processes.push({
      id: procId,
      label,
      type,
      stepCount,
      steps: stepRows.map(s => ({
        step: s.step || s[3] || 0,
        name: s.name || s[0],
        filePath: s.filePath || s[1],
        type: extractLabel(s.type || s[2]),
      })),
    });
  }

  return processes;
}

/**
 * Get all processes in the graph (for overview page).
 */
export async function getAllProcesses(limit = 20): Promise<ProcessInfo[]> {
  const procRows = await executeQuery(REPO_ID, `
    MATCH (p:Process)
    RETURN p.id AS id, p.heuristicLabel AS label,
           p.processType AS type, p.stepCount AS stepCount
    ORDER BY stepCount DESC
    LIMIT ${limit}
  `);

  const processes: ProcessInfo[] = [];
  for (const row of procRows) {
    const procId = row.id || row[0];
    const label = row.label || row[1] || procId;
    const type = row.type || row[2] || 'unknown';
    const stepCount = row.stepCount || row[3] || 0;

    const stepRows = await executeQuery(REPO_ID, `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${procId.replace(/'/g, "''")}'})
      RETURN s.name AS name, s.filePath AS filePath, labels(s) AS type, r.step AS step
      ORDER BY r.step
    `);

    processes.push({
      id: procId,
      label,
      type,
      stepCount,
      steps: stepRows.map(s => ({
        step: s.step || s[3] || 0,
        name: s.name || s[0],
        filePath: s.filePath || s[1],
        type: extractLabel(s.type || s[2]),
      })),
    });
  }

  return processes;
}

/**
 * Get inter-module edges for overview architecture diagram.
 * Groups call edges by source/target module.
 */
export async function getInterModuleEdgesForOverview(
  moduleFiles: Record<string, string[]>
): Promise<Array<{ from: string; to: string; count: number }>> {
  // Build file-to-module lookup
  const fileToModule = new Map<string, string>();
  for (const [mod, files] of Object.entries(moduleFiles)) {
    for (const f of files) {
      fileToModule.set(f, mod);
    }
  }

  const allEdges = await getInterFileCallEdges();
  const moduleEdgeCounts = new Map<string, number>();

  for (const edge of allEdges) {
    const fromMod = fileToModule.get(edge.fromFile);
    const toMod = fileToModule.get(edge.toFile);
    if (fromMod && toMod && fromMod !== toMod) {
      const key = `${fromMod}|||${toMod}`;
      moduleEdgeCounts.set(key, (moduleEdgeCounts.get(key) || 0) + 1);
    }
  }

  return Array.from(moduleEdgeCounts.entries())
    .map(([key, count]) => {
      const [from, to] = key.split('|||');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);
}

// ─── Blueprint / Unreal Queries ──────────────────────────────────────

// Blueprint-family labels used for querying UE asset nodes (from centralized registry)
const BLUEPRINT_LABELS = UE_ASSET_LABELS;

/**
 * Get all Blueprint asset nodes from the graph.
 * Returns empty array if no Unreal content is indexed (detection signal).
 */
export async function getBlueprintAssets(): Promise<BlueprintAssetInfo[]> {
  // Query each Blueprint-family label and union the results
  const allRows: Array<Record<string, unknown> & { _label: string }> = [];
  for (const label of BLUEPRINT_LABELS) {
    const rows = await executeQuery(REPO_ID, `
      MATCH (b:${label})
      RETURN b.filePath AS assetPath, b.name AS name
    `);
    for (const r of rows) {
      allRows.push({ ...r, _label: label });
    }
  }

  // Deduplicate by assetPath (a node may match multiple labels)
  const seen = new Set<string>();
  const results: BlueprintAssetInfo[] = [];
  for (const r of allRows) {
    const assetPath = (r.assetPath || r[0]) as string;
    if (seen.has(assetPath)) continue;
    seen.add(assetPath);
    results.push({
      assetPath,
      name: (r.name || r[1]) as string,
      label: r._label,
      assetClass: r._label,
    });
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get structured edge data for a set of Blueprint asset paths.
 * Returns a Map keyed by asset path with all relationship targets.
 */
export async function getBlueprintEdgesForAssets(
  assetPaths: string[],
): Promise<Map<string, BlueprintEdgeData>> {
  if (assetPaths.length === 0) return new Map();

  const result = new Map<string, BlueprintEdgeData>();
  for (const ap of assetPaths) {
    result.set(ap, {
      extends: [], calls: [], imports: [],
      implements: [], overrides: [], dispatches: [], gameplayTags: [],
    });
  }

  const pathList = assetPaths.map(p => `'${p.replace(/'/g, "''")}'`).join(', ');

  // Query all outgoing edges from these Blueprints in one batch
  const edgeTypes = ['EXTENDS', 'CALLS', 'IMPORTS', 'IMPLEMENTS', 'OVERRIDES', 'DISPATCHES', 'REFERENCES_TAG'];
  const typeList = edgeTypes.map(t => `'${t}'`).join(', ');

  const rows = await executeQuery(REPO_ID, `
    MATCH (src)-[r:CodeRelation]->(tgt)
    WHERE src.filePath IN [${pathList}] AND r.type IN [${typeList}]
    RETURN src.filePath AS srcPath, r.type AS edgeType, tgt.name AS targetName
  `);

  for (const row of rows) {
    const srcPath = row.srcPath || row[0];
    const edgeType = row.edgeType || row[1];
    const targetName = row.targetName || row[2];
    const entry = result.get(srcPath);
    if (!entry || !targetName) continue;

    switch (edgeType) {
      case 'EXTENDS': entry.extends.push(targetName); break;
      case 'CALLS': entry.calls.push(targetName); break;
      case 'IMPORTS': entry.imports.push(targetName); break;
      case 'IMPLEMENTS': entry.implements.push(targetName); break;
      case 'OVERRIDES': entry.overrides.push(targetName); break;
      case 'DISPATCHES': entry.dispatches.push(targetName); break;
      case 'REFERENCES_TAG': entry.gameplayTags.push(targetName); break;
    }
  }

  return result;
}

/**
 * Count Blueprint-family nodes by label for the overview page.
 */
export async function getBlueprintAssetDistribution(): Promise<Record<string, number>> {
  const dist: Record<string, number> = {};
  for (const label of BLUEPRINT_LABELS) {
    const rows = await executeQuery(REPO_ID, `
      MATCH (b:${label})
      RETURN count(b) AS cnt
    `);
    const cnt = (rows[0]?.cnt || rows[0]?.[0] || 0) as number;
    if (cnt > 0) dist[label] = cnt;
  }
  return dist;
}

/**
 * Get top gameplay tags by reference count for the overview page.
 */
export async function getGameplayTagSummary(limit = 20): Promise<Array<{ tag: string; refCount: number }>> {
  const rows = await executeQuery(REPO_ID, `
    MATCH (b)-[:CodeRelation {type: 'REFERENCES_TAG'}]->(t:GameplayTag)
    RETURN t.name AS tag, count(b) AS refCount
    ORDER BY refCount DESC
    LIMIT ${limit}
  `);

  return rows.map(r => ({
    tag: r.tag || r[0],
    refCount: r.refCount || r[1] || 0,
  }));
}
