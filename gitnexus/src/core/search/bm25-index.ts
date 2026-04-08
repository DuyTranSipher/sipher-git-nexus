/**
 * Full-Text Search via LadybugDB FTS
 *
 * Uses LadybugDB's built-in full-text search indexes for keyword-based search.
 * Always reads from the database (no cached state to drift).
 */

import { queryFTS } from '../lbug/lbug-adapter.js';
import { UE_FTS_TABLES } from '../../unreal/asset-types.js';

export interface BM25SearchResult {
  filePath: string;
  score: number;
  rank: number;
}

/**
 * Execute a single FTS query via a custom executor (for MCP connection pool).
 * Returns the same shape as core queryFTS (from LadybugDB adapter).
 */
async function queryFTSViaExecutor(
  executor: (cypher: string) => Promise<any[]>,
  tableName: string,
  indexName: string,
  query: string,
  limit: number,
): Promise<Array<{ filePath: string; score: number }>> {
  // Escape single quotes and backslashes to prevent Cypher injection
  const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', '${escapedQuery}', conjunctive := false)
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;
  try {
    const rows = await executor(cypher);
    return rows.map((row: any) => {
      const node = row.node || row[0] || {};
      const score = row.score ?? row[1] ?? 0;
      return {
        filePath: node.filePath || '',
        score: typeof score === 'number' ? score : parseFloat(score) || 0,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Search using LadybugDB's built-in FTS (always fresh, reads from disk)
 *
 * Queries multiple node tables (File, Function, Class, Method) in parallel
 * and merges results by filePath, summing scores for the same file.
 *
 * @param query - Search query string
 * @param limit - Maximum results
 * @param repoId - If provided, queries will be routed via the MCP connection pool
 * @returns Ranked search results from FTS indexes
 */
export const searchFTSFromLbug = async (query: string, limit: number = 20, repoId?: string): Promise<BM25SearchResult[]> => {
  // Core code tables (always present)
  const CORE_TABLES: [string, string][] = [
    ['File', 'file_fts'],
    ['Function', 'function_fts'],
    ['Class', 'class_fts'],
    ['Method', 'method_fts'],
    ['Interface', 'interface_fts'],
  ];
  const allTables = [...CORE_TABLES, ...UE_FTS_TABLES];

  // IMPORTANT: FTS queries run sequentially to avoid connection contention.
  const allResults: any[][] = [];
  if (repoId) {
    const { executeQuery } = await import('../../mcp/core/lbug-adapter.js');
    const executor = (cypher: string) => executeQuery(repoId, cypher);
    for (const [table, index] of allTables) {
      allResults.push(await queryFTSViaExecutor(executor, table, index, query, limit));
    }
  } else {
    for (const [table, index] of allTables) {
      allResults.push(await queryFTS(table, index, query, limit, false).catch(() => []));
    }
  }

  // Merge results by filePath, summing scores for same file
  const merged = new Map<string, { filePath: string; score: number }>();

  const addResults = (results: any[]) => {
    for (const r of results) {
      const existing = merged.get(r.filePath);
      if (existing) {
        existing.score += r.score;
      } else {
        merged.set(r.filePath, { filePath: r.filePath, score: r.score });
      }
    }
  };

  for (const results of allResults) {
    addResults(results);
  }

  // Sort by score descending and add rank
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  return sorted.map((r, index) => ({
    filePath: r.filePath,
    score: r.score,
    rank: index + 1,
  }));
};
