/**
 * Wiki Generator
 * 
 * Orchestrates the full wiki generation pipeline:
 *   Phase 0: Validate prerequisites + gather graph structure
 *   Phase 1: Build module tree (one LLM call)
 *   Phase 2: Generate module pages (one LLM call per module, bottom-up)
 *   Phase 3: Generate overview page
 * 
 * Supports incremental updates via git diff + module-file mapping.
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync, execFileSync } from 'child_process';

import {
  initWikiDb,
  closeWikiDb,
  getFilesWithExports,
  getAllFiles,
  getInterFileCallEdges,
  getIntraModuleCallEdges,
  getInterModuleCallEdges,
  getProcessesForFiles,
  getAllProcesses,
  getInterModuleEdgesForOverview,
  type FileWithExports,
} from './graph-queries.js';
import { generateHTMLViewer } from './html-viewer.js';

import {
  callLLM,
  estimateTokens,
  type LLMConfig,
  type CallLLMOptions,
} from './llm-client.js';

import {
  GROUPING_SYSTEM_PROMPT,
  GROUPING_USER_PROMPT,
  MODULE_SYSTEM_PROMPT,
  MODULE_USER_PROMPT,
  PARENT_SYSTEM_PROMPT,
  PARENT_USER_PROMPT,
  OVERVIEW_SYSTEM_PROMPT,
  OVERVIEW_USER_PROMPT,
  fillTemplate,
  formatFileListForGrouping,
  formatDirectoryTree,
  formatCallEdges,
  formatProcesses,
} from './prompts.js';

import { shouldIgnorePath } from '../../config/ignore-service.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface WikiOptions {
  force?: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokensPerModule?: number;
  concurrency?: number;
}

export interface WikiMeta {
  fromCommit: string;
  generatedAt: string;
  model: string;
  moduleFiles: Record<string, string[]>;
  moduleTree: ModuleTreeNode[];
  failedModules?: string[];
}

export interface ModuleTreeNode {
  name: string;
  slug: string;
  files: string[];
  children?: ModuleTreeNode[];
}

export type ProgressCallback = (phase: string, percent: number, detail?: string) => void;

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS_PER_MODULE = 30_000;
const WIKI_DIR = 'wiki';
export const MAX_WIKI_PROMPT_TOKENS = 120_000;
const LARGE_REPO_GROUPING_FILE_THRESHOLD = 1_500;
const MAX_FILES_PER_DETERMINISTIC_GROUP = 250;
const MAX_GROUPING_BATCH_TOKENS = 40_000;
const MAX_LEAF_SOURCE_TOKENS = 70_000;
const MAX_EDGE_SECTION_TOKENS = 10_000;
const MAX_PROCESS_SECTION_TOKENS = 10_000;
const MAX_PARENT_CHILD_DOC_TOKENS = 80_000;
const MAX_OVERVIEW_SUMMARY_TOKENS = 80_000;
const MAX_PROJECT_INFO_TOKENS = 10_000;
const WIKI_CODE_SUFFIXES = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.kt', '.kts', '.cs',
  '.go', '.rs', '.php', '.rb', '.swift',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
  '.m', '.mm',
  '.usf', '.ush', '.glsl', '.hlsl',
] as const;

export function isWikiPromptExcludedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('.uasset') || normalized.endsWith('.umap');
}

export function isWikiCodeFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return WIKI_CODE_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

export function filterWikiPromptPaths(filePaths: string[]): string[] {
  return filePaths.filter(filePath => !isWikiPromptExcludedPath(filePath) && isWikiCodeFilePath(filePath));
}

export function estimateGroupingPromptTokens(files: FileWithExports[]): number {
  const fileList = formatFileListForGrouping(files);
  const dirTree = formatDirectoryTree(files.map(f => f.filePath));
  const prompt = fillTemplate(GROUPING_USER_PROMPT, {
    FILE_LIST: fileList,
    DIRECTORY_TREE: dirTree,
  });
  return estimateTokens(prompt);
}

export function shouldUseDeterministicGrouping(fileCount: number, promptTokens: number): boolean {
  return fileCount > LARGE_REPO_GROUPING_FILE_THRESHOLD || promptTokens > MAX_WIKI_PROMPT_TOKENS;
}

function truncateTextToTokenBudget(text: string, maxTokens: number, notice: string): string {
  if (maxTokens <= 0) return notice.trim();
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = Math.max(0, (maxTokens * 4) - notice.length);
  return text.slice(0, maxChars) + notice;
}

// ─── Generator Class ──────────────────────────────────────────────────

export class WikiGenerator {
  private repoPath: string;
  private storagePath: string;
  private wikiDir: string;
  private lbugPath: string;
  private llmConfig: LLMConfig;
  private maxTokensPerModule: number;
  private concurrency: number;
  private options: WikiOptions;
  private onProgress: ProgressCallback;
  private failedModules: string[] = [];

  constructor(
    repoPath: string,
    storagePath: string,
    lbugPath: string,
    llmConfig: LLMConfig,
    options: WikiOptions = {},
    onProgress?: ProgressCallback,
  ) {
    this.repoPath = repoPath;
    this.storagePath = storagePath;
    this.wikiDir = path.join(storagePath, WIKI_DIR);
    this.lbugPath = lbugPath;
    this.options = options;
    this.llmConfig = llmConfig;
    this.maxTokensPerModule = options.maxTokensPerModule ?? DEFAULT_MAX_TOKENS_PER_MODULE;
    this.concurrency = options.concurrency ?? 3;
    const progressFn = onProgress || (() => {});
    this.onProgress = (phase, percent, detail) => {
      if (percent > 0) this.lastPercent = percent;
      progressFn(phase, percent, detail);
    };
  }

  private lastPercent = 0;

  /**
   * Create streaming options that report LLM progress to the progress bar.
   * Uses the last known percent so streaming doesn't reset the bar backwards.
   */
  private streamOpts(label: string, fixedPercent?: number): CallLLMOptions {
    return {
      onChunk: (chars: number) => {
        const tokens = Math.round(chars / 4);
        const pct = fixedPercent ?? this.lastPercent;
        this.onProgress('stream', pct, `${label} (${tokens} tok)`);
      },
    };
  }

  /**
   * Main entry point. Runs the full pipeline or incremental update.
   */
  async run(): Promise<{ pagesGenerated: number; mode: 'full' | 'incremental' | 'up-to-date'; failedModules: string[] }> {
    await fs.mkdir(this.wikiDir, { recursive: true });

    const existingMeta = await this.loadWikiMeta();
    const currentCommit = this.getCurrentCommit();
    const forceMode = this.options.force;

    // Up-to-date check (skip if --force)
    if (!forceMode && existingMeta && existingMeta.fromCommit === currentCommit) {
      // If previous run had failed modules, retry them instead of skipping
      if (existingMeta.failedModules?.length) {
        this.onProgress('init', 2, 'Retrying previously failed modules...');
        await initWikiDb(this.lbugPath);
        let retryResult: { pagesGenerated: number; mode: 'full' | 'incremental' | 'up-to-date'; failedModules: string[] };
        try {
          retryResult = await this.retryFailedModules(existingMeta, currentCommit);
        } finally {
          await closeWikiDb();
        }
        await this.ensureHTMLViewer();
        return retryResult;
      }
      // Still regenerate the HTML viewer in case it's missing
      await this.ensureHTMLViewer();
      return { pagesGenerated: 0, mode: 'up-to-date', failedModules: [] };
    }

    // Force mode: delete snapshot to force full re-grouping
    if (forceMode) {
      try { await fs.unlink(path.join(this.wikiDir, 'first_module_tree.json')); } catch {}
      // Delete existing module pages so they get regenerated
      const existingFiles = await fs.readdir(this.wikiDir).catch(() => [] as string[]);
      for (const f of existingFiles) {
        if (f.endsWith('.md')) {
          try { await fs.unlink(path.join(this.wikiDir, f)); } catch {}
        }
      }
    }

    // Init graph
    this.onProgress('init', 2, 'Connecting to knowledge graph...');
    await initWikiDb(this.lbugPath);

    let result: { pagesGenerated: number; mode: 'full' | 'incremental' | 'up-to-date'; failedModules: string[] };
    try {
      if (!forceMode && existingMeta && existingMeta.fromCommit) {
        result = await this.incrementalUpdate(existingMeta, currentCommit);
      } else {
        result = await this.fullGeneration(currentCommit);
      }
    } finally {
      await closeWikiDb();
    }

    // Always generate the HTML viewer after wiki content changes
    await this.ensureHTMLViewer();

    return result;
  }

  // ─── HTML Viewer ─────────────────────────────────────────────────────

  private async ensureHTMLViewer(): Promise<void> {
    // Only generate if there are markdown pages to bundle
    const dirEntries = await fs.readdir(this.wikiDir).catch(() => [] as string[]);
    const hasMd = dirEntries.some(f => f.endsWith('.md'));
    if (!hasMd) return;

    this.onProgress('html', 98, 'Building HTML viewer...');
    const repoName = path.basename(this.repoPath);
    await generateHTMLViewer(this.wikiDir, repoName);
  }

  // ─── Full Generation ────────────────────────────────────────────────

  private async fullGeneration(currentCommit: string): Promise<{ pagesGenerated: number; mode: 'full'; failedModules: string[] }> {
    let pagesGenerated = 0;

    // Phase 0: Gather structure
    this.onProgress('gather', 5, 'Querying graph for file structure...');
    const filesWithExports = await getFilesWithExports();
    const allFiles = await getAllFiles();

    // Filter to source files only
    const sourceFiles = allFiles.filter(f => !shouldIgnorePath(f) && !isWikiPromptExcludedPath(f) && isWikiCodeFilePath(f));
    if (sourceFiles.length === 0) {
      throw new Error('No source files found in the knowledge graph. Nothing to document.');
    }

    // Build enriched file list (merge exports into all source files)
    const exportMap = new Map(filesWithExports.map(f => [f.filePath, f]));
    const enrichedFiles: FileWithExports[] = sourceFiles.map(fp => {
      return exportMap.get(fp) || { filePath: fp, symbols: [] };
    });

    this.onProgress('gather', 10, `Found ${sourceFiles.length} source files`);

    // Phase 1: Build module tree
    const moduleTree = await this.buildModuleTree(enrichedFiles);
    pagesGenerated = 0;

    // Phase 2: Generate module pages (parallel with concurrency limit)
    const totalModules = this.countModules(moduleTree);
    let modulesProcessed = 0;

    const reportProgress = (moduleName?: string) => {
      modulesProcessed++;
      const percent = 30 + Math.round((modulesProcessed / totalModules) * 55);
      const detail = moduleName
        ? `${modulesProcessed}/${totalModules} — ${moduleName}`
        : `${modulesProcessed}/${totalModules} modules`;
      this.onProgress('modules', percent, detail);
    };

    // Flatten tree into layers: leaves first, then parents
    // Leaves can run in parallel; parents must wait for their children
    const { leaves, parents } = this.flattenModuleTree(moduleTree);

    // Process all leaf modules in parallel
    pagesGenerated += await this.runParallel(leaves, async (node) => {
      const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
      if (await this.fileExists(pagePath)) {
        reportProgress(node.name);
        return 0;
      }
      try {
        await this.generateLeafPage(node);
        reportProgress(node.name);
        return 1;
      } catch (err: any) {
        this.failedModules.push(node.name);
        reportProgress(`Failed: ${node.name}`);
        return 0;
      }
    });

    // Process parent modules sequentially (they depend on child docs)
    for (const node of parents) {
      const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
      if (await this.fileExists(pagePath)) {
        reportProgress(node.name);
        continue;
      }
      try {
        await this.generateParentPage(node);
        pagesGenerated++;
        reportProgress(node.name);
      } catch (err: any) {
        this.failedModules.push(node.name);
        reportProgress(`Failed: ${node.name}`);
      }
    }

    // Phase 3: Generate overview
    this.onProgress('overview', 88, 'Generating overview page...');
    await this.generateOverview(moduleTree);
    pagesGenerated++;

    // Save metadata (include failed modules so retry can find them)
    this.onProgress('finalize', 95, 'Saving metadata...');
    const moduleFiles = this.extractModuleFiles(moduleTree);
    await this.saveModuleTree(moduleTree);
    await this.saveWikiMeta({
      fromCommit: currentCommit,
      generatedAt: new Date().toISOString(),
      model: this.llmConfig.model,
      moduleFiles,
      moduleTree,
      failedModules: this.failedModules.length > 0 ? [...this.failedModules] : undefined,
    });

    this.onProgress('done', 100, 'Wiki generation complete');
    return { pagesGenerated, mode: 'full', failedModules: [...this.failedModules] };
  }

  // ─── Retry Failed Modules ──────────────────────────────────────────

  /**
   * Retry only the modules that failed in a previous run.
   * Finds them in the saved module tree and regenerates their pages.
   */
  private async retryFailedModules(
    existingMeta: WikiMeta,
    currentCommit: string,
  ): Promise<{ pagesGenerated: number; mode: 'full'; failedModules: string[] }> {
    const failedNames = new Set(existingMeta.failedModules ?? []);
    const moduleTree = existingMeta.moduleTree;
    const { leaves, parents } = this.flattenModuleTree(moduleTree);

    const failedLeaves = leaves.filter(n => failedNames.has(n.name));
    const failedParents = parents.filter(n => failedNames.has(n.name));
    const totalRetries = failedLeaves.length + failedParents.length;
    let processed = 0;
    let pagesGenerated = 0;

    const reportProgress = (moduleName?: string) => {
      processed++;
      const percent = 10 + Math.round((processed / totalRetries) * 75);
      const detail = moduleName
        ? `Retry ${processed}/${totalRetries} — ${moduleName}`
        : `Retry ${processed}/${totalRetries}`;
      this.onProgress('retry', percent, detail);
    };

    // Delete existing failed pages so they get regenerated
    for (const name of failedNames) {
      const node = [...leaves, ...parents].find(n => n.name === name);
      if (node) {
        try { await fs.unlink(path.join(this.wikiDir, `${node.slug}.md`)); } catch {}
      }
    }

    // Retry leaf modules in parallel
    pagesGenerated += await this.runParallel(failedLeaves, async (node) => {
      try {
        await this.generateLeafPage(node);
        reportProgress(node.name);
        return 1;
      } catch {
        this.failedModules.push(node.name);
        reportProgress(`Failed: ${node.name}`);
        return 0;
      }
    });

    // Retry parent modules sequentially
    for (const node of failedParents) {
      try {
        await this.generateParentPage(node);
        pagesGenerated++;
        reportProgress(node.name);
      } catch {
        this.failedModules.push(node.name);
        reportProgress(`Failed: ${node.name}`);
      }
    }

    // Regenerate overview if any pages were recovered
    if (pagesGenerated > 0) {
      this.onProgress('overview', 88, 'Regenerating overview page...');
      await this.generateOverview(moduleTree);
    }

    // Update metadata
    this.onProgress('finalize', 95, 'Saving metadata...');
    const moduleFiles = this.extractModuleFiles(moduleTree);
    await this.saveWikiMeta({
      fromCommit: currentCommit,
      generatedAt: new Date().toISOString(),
      model: this.llmConfig.model,
      moduleFiles,
      moduleTree,
      failedModules: this.failedModules.length > 0 ? [...this.failedModules] : undefined,
    });

    this.onProgress('done', 100, 'Retry complete');
    return { pagesGenerated, mode: 'full', failedModules: [...this.failedModules] };
  }

  // ─── Phase 1: Build Module Tree ────────────────────────────────────

  private async buildModuleTree(files: FileWithExports[]): Promise<ModuleTreeNode[]> {
    // Check for existing immutable snapshot (resumability)
    const snapshotPath = path.join(this.wikiDir, 'first_module_tree.json');
    try {
      const existing = await fs.readFile(snapshotPath, 'utf-8');
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed) && parsed.length > 0) {
        this.onProgress('grouping', 25, 'Using existing module tree (resuming)');
        return parsed;
      }
    } catch {
      // No snapshot, generate new
    }

    const groupingPromptTokens = estimateGroupingPromptTokens(files);
    let tree: ModuleTreeNode[];

    if (shouldUseDeterministicGrouping(files.length, groupingPromptTokens)) {
      this.onProgress('grouping', 15, `Large repo detected (${files.length} files, ${groupingPromptTokens} tok) — using deterministic grouping`);
      tree = this.buildDeterministicModuleTree(files);
    } else {
      this.onProgress('grouping', 15, 'Grouping files into modules (LLM)...');

      const fileList = formatFileListForGrouping(files);
      const dirTree = formatDirectoryTree(files.map(f => f.filePath));

      const prompt = fillTemplate(GROUPING_USER_PROMPT, {
        FILE_LIST: fileList,
        DIRECTORY_TREE: dirTree,
      });

      this.assertPromptWithinBudget(prompt, 'Grouping');

      const response = await callLLM(
        prompt, this.llmConfig, GROUPING_SYSTEM_PROMPT,
        this.streamOpts('Grouping files', 15),
      );
      const grouping = this.parseGroupingResponse(response.content, files);

      tree = [];
      for (const [moduleName, modulePaths] of Object.entries(grouping)) {
        const slug = this.slugify(moduleName);
        const node: ModuleTreeNode = { name: moduleName, slug, files: modulePaths };

        const totalTokens = await this.estimateModuleTokens(modulePaths);
        if (totalTokens > this.maxTokensPerModule && modulePaths.length > 3) {
          node.children = this.splitBySubdirectory(moduleName, modulePaths);
          node.files = [];
        }

        tree.push(node);
      }
    }

    // Save immutable snapshot for resumability
    await fs.writeFile(snapshotPath, JSON.stringify(tree, null, 2), 'utf-8');
    this.onProgress('grouping', 28, `Created ${tree.length} modules`);

    return tree;
  }

  /**
   * Parse LLM grouping response. Validates all files are assigned.
   */
  private parseGroupingResponse(
    content: string,
    files: FileWithExports[],
  ): Record<string, string[]> {
    // Extract JSON from response (handle markdown fences)
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    let parsed: Record<string, string[]>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Fallback: group by top-level directory
      return this.fallbackGrouping(files);
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return this.fallbackGrouping(files);
    }

    // Validate — ensure all files are assigned
    const allFilePaths = new Set(files.map(f => f.filePath));
    const assignedFiles = new Set<string>();
    const validGrouping: Record<string, string[]> = {};

    for (const [mod, paths] of Object.entries(parsed)) {
      if (!Array.isArray(paths)) continue;
      const validPaths = paths.filter(p => {
        if (allFilePaths.has(p) && !assignedFiles.has(p)) {
          assignedFiles.add(p);
          return true;
        }
        return false;
      });
      if (validPaths.length > 0) {
        validGrouping[mod] = validPaths;
      }
    }

    // Assign unassigned files to a "Miscellaneous" module
    const unassigned = files
      .map(f => f.filePath)
      .filter(fp => !assignedFiles.has(fp));
    if (unassigned.length > 0) {
      validGrouping['Other'] = unassigned;
    }

    return Object.keys(validGrouping).length > 0
      ? validGrouping
      : this.fallbackGrouping(files);
  }

  /**
   * Fallback grouping by top-level directory when LLM parsing fails.
   */
  private fallbackGrouping(files: FileWithExports[]): Record<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const parts = f.filePath.replace(/\\/g, '/').split('/');
      const topDir = parts.length > 1 ? parts[0] : 'Root';
      let group = groups.get(topDir);
      if (!group) { group = []; groups.set(topDir, group); }
      group.push(f.filePath);
    }
    return Object.fromEntries(groups);
  }

  /**
   * Split a large module into sub-modules by subdirectory.
   */
  private splitBySubdirectory(moduleName: string, files: string[]): ModuleTreeNode[] {
    const subGroups = new Map<string, string[]>();
    for (const fp of files) {
      const parts = fp.replace(/\\/g, '/').split('/');
      // Use the deepest common-ish directory
      const subDir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
      let group = subGroups.get(subDir);
      if (!group) { group = []; subGroups.set(subDir, group); }
      group.push(fp);
    }

    const children: ModuleTreeNode[] = [];
    for (const [subDir, subFiles] of Array.from(subGroups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      const chunked = this.chunkFiles(subFiles.sort());
      chunked.forEach((chunk, index) => {
        const suffix = chunked.length > 1 ? ` ${index + 1}` : '';
        const childName = `${moduleName} — ${path.basename(subDir)}${suffix}`;
        children.push({
          name: childName,
          slug: this.slugify(`${moduleName}-${path.basename(subDir)}-${index + 1}`),
          files: chunk,
        });
      });
    }
    return children;
  }

  // ─── Phase 2: Generate Module Pages ─────────────────────────────────

  /**
   * Generate a leaf module page from source code + graph data.
   */
  private async generateLeafPage(node: ModuleTreeNode): Promise<void> {
    const filePaths = node.files;

    // Read source files from disk
    const sourceCode = await this.readSourceFiles(filePaths);

    const finalSourceCode = truncateTextToTokenBudget(
      sourceCode,
      Math.min(this.maxTokensPerModule, MAX_LEAF_SOURCE_TOKENS),
      '\n\n... (source truncated for context window limits)',
    );

    // Get graph data
    const [intraCalls, interCalls, processes] = await Promise.all([
      getIntraModuleCallEdges(filePaths),
      getInterModuleCallEdges(filePaths),
      getProcessesForFiles(filePaths, 5),
    ]);

    const intraCallsText = truncateTextToTokenBudget(
      formatCallEdges(intraCalls),
      MAX_EDGE_SECTION_TOKENS,
      '\n... (internal calls truncated)',
    );
    const outgoingCallsText = truncateTextToTokenBudget(
      formatCallEdges(interCalls.outgoing),
      MAX_EDGE_SECTION_TOKENS,
      '\n... (outgoing calls truncated)',
    );
    const incomingCallsText = truncateTextToTokenBudget(
      formatCallEdges(interCalls.incoming),
      MAX_EDGE_SECTION_TOKENS,
      '\n... (incoming calls truncated)',
    );
    const processesText = truncateTextToTokenBudget(
      formatProcesses(processes),
      MAX_PROCESS_SECTION_TOKENS,
      '\n... (processes truncated)',
    );

    const prompt = fillTemplate(MODULE_USER_PROMPT, {
      MODULE_NAME: node.name,
      SOURCE_CODE: finalSourceCode,
      INTRA_CALLS: intraCallsText,
      OUTGOING_CALLS: outgoingCallsText,
      INCOMING_CALLS: incomingCallsText,
      PROCESSES: processesText,
    });

    this.assertPromptWithinBudget(prompt, `Leaf module ${node.name}`);

    const response = await callLLM(
      prompt, this.llmConfig, MODULE_SYSTEM_PROMPT,
      this.streamOpts(node.name),
    );

    // Write page with front matter
    const pageContent = `# ${node.name}\n\n${response.content}`;
    await fs.writeFile(path.join(this.wikiDir, `${node.slug}.md`), pageContent, 'utf-8');
  }

  /**
   * Generate a parent module page from children's documentation.
   */
  private async generateParentPage(node: ModuleTreeNode): Promise<void> {
    if (!node.children || node.children.length === 0) return;

    // Read children's overview sections
    const childDocs: string[] = [];
    for (const child of node.children) {
      const childPage = path.join(this.wikiDir, `${child.slug}.md`);
      try {
        const content = await fs.readFile(childPage, 'utf-8');
        // Extract overview section (first ~500 chars or up to "### Architecture")
        const overviewEnd = content.indexOf('### Architecture');
        const overview = overviewEnd > 0 ? content.slice(0, overviewEnd).trim() : content.slice(0, 800).trim();
        childDocs.push(`#### ${child.name}\n${overview}`);
      } catch {
        childDocs.push(`#### ${child.name}\n(Documentation not yet generated)`);
      }
    }

    // Get cross-child call edges
    const allChildFiles = node.children.flatMap(c => c.files);
    const crossCalls = await getIntraModuleCallEdges(allChildFiles);
    const processes = await getProcessesForFiles(allChildFiles, 3);

    const childDocsText = truncateTextToTokenBudget(
      childDocs.join('\n\n'),
      MAX_PARENT_CHILD_DOC_TOKENS,
      '\n\n... (child documentation truncated)',
    );
    const crossCallsText = truncateTextToTokenBudget(
      formatCallEdges(crossCalls),
      MAX_EDGE_SECTION_TOKENS,
      '\n... (cross-module calls truncated)',
    );
    const crossProcessesText = truncateTextToTokenBudget(
      formatProcesses(processes),
      MAX_PROCESS_SECTION_TOKENS,
      '\n... (shared processes truncated)',
    );

    const prompt = fillTemplate(PARENT_USER_PROMPT, {
      MODULE_NAME: node.name,
      CHILDREN_DOCS: childDocsText,
      CROSS_MODULE_CALLS: crossCallsText,
      CROSS_PROCESSES: crossProcessesText,
    });

    this.assertPromptWithinBudget(prompt, `Parent module ${node.name}`);

    const response = await callLLM(
      prompt, this.llmConfig, PARENT_SYSTEM_PROMPT,
      this.streamOpts(node.name),
    );

    const pageContent = `# ${node.name}\n\n${response.content}`;
    await fs.writeFile(path.join(this.wikiDir, `${node.slug}.md`), pageContent, 'utf-8');
  }

  // ─── Phase 3: Generate Overview ─────────────────────────────────────

  private async generateOverview(moduleTree: ModuleTreeNode[]): Promise<void> {
    // Read module overview sections
    const moduleSummaries: string[] = [];
    for (const node of moduleTree) {
      const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
      try {
        const content = await fs.readFile(pagePath, 'utf-8');
        const overviewEnd = content.indexOf('### Architecture');
        const overview = overviewEnd > 0 ? content.slice(0, overviewEnd).trim() : content.slice(0, 600).trim();
        moduleSummaries.push(`#### ${node.name}\n${overview}`);
      } catch {
        moduleSummaries.push(`#### ${node.name}\n(Documentation pending)`);
      }
    }

    // Get inter-module edges for architecture diagram
    const moduleFiles = this.extractModuleFiles(moduleTree);
    const moduleEdges = await getInterModuleEdgesForOverview(moduleFiles);

    // Get top processes for key workflows
    const topProcesses = await getAllProcesses(5);

    // Read project config
    const projectInfo = await this.readProjectInfo();

    const edgesText = moduleEdges.length > 0
      ? moduleEdges.map(e => `${e.from} → ${e.to} (${e.count} calls)`).join('\n')
      : 'No inter-module call edges detected';
    const trimmedModuleSummaries = truncateTextToTokenBudget(
      moduleSummaries.join('\n\n'),
      MAX_OVERVIEW_SUMMARY_TOKENS,
      '\n\n... (module summaries truncated)',
    );
    const trimmedEdgesText = truncateTextToTokenBudget(
      edgesText,
      MAX_EDGE_SECTION_TOKENS,
      '\n... (inter-module edges truncated)',
    );
    const trimmedProcessesText = truncateTextToTokenBudget(
      formatProcesses(topProcesses),
      MAX_PROCESS_SECTION_TOKENS,
      '\n... (top processes truncated)',
    );
    const trimmedProjectInfo = truncateTextToTokenBudget(
      projectInfo,
      MAX_PROJECT_INFO_TOKENS,
      '\n... (project info truncated)',
    );

    const prompt = fillTemplate(OVERVIEW_USER_PROMPT, {
      PROJECT_INFO: trimmedProjectInfo,
      MODULE_SUMMARIES: trimmedModuleSummaries,
      MODULE_EDGES: trimmedEdgesText,
      TOP_PROCESSES: trimmedProcessesText,
    });

    this.assertPromptWithinBudget(prompt, 'Overview');

    const response = await callLLM(
      prompt, this.llmConfig, OVERVIEW_SYSTEM_PROMPT,
      this.streamOpts('Generating overview', 88),
    );

    const pageContent = `# ${path.basename(this.repoPath)} — Wiki\n\n${response.content}`;
    await fs.writeFile(path.join(this.wikiDir, 'overview.md'), pageContent, 'utf-8');
  }

  // ─── Incremental Updates ────────────────────────────────────────────

  private async incrementalUpdate(
    existingMeta: WikiMeta,
    currentCommit: string,
  ): Promise<{ pagesGenerated: number; mode: 'incremental'; failedModules: string[] }> {
    this.onProgress('incremental', 5, 'Detecting changes...');

    // Get changed files since last generation
    const changedFiles = this.getChangedFiles(existingMeta.fromCommit, currentCommit);
    if (changedFiles.length === 0) {
      // No file changes but commit differs (e.g. merge commit)
      await this.saveWikiMeta({
        ...existingMeta,
        fromCommit: currentCommit,
        generatedAt: new Date().toISOString(),
      });
      return { pagesGenerated: 0, mode: 'incremental', failedModules: [] };
    }

    this.onProgress('incremental', 10, `${changedFiles.length} files changed`);

    // Determine affected modules
    const affectedModules = new Set<string>();
    const newFiles: string[] = [];

    for (const fp of changedFiles) {
      let found = false;
      for (const [mod, files] of Object.entries(existingMeta.moduleFiles)) {
        if (files.includes(fp)) {
          affectedModules.add(mod);
          found = true;
          break;
        }
      }
      if (!found && !shouldIgnorePath(fp) && !isWikiPromptExcludedPath(fp) && isWikiCodeFilePath(fp)) {
        newFiles.push(fp);
      }
    }

    // If significant new files exist, re-run full grouping
    if (newFiles.length > 5) {
      this.onProgress('incremental', 15, 'Significant new files detected, running full generation...');
      // Delete old snapshot to force re-grouping
      try { await fs.unlink(path.join(this.wikiDir, 'first_module_tree.json')); } catch {}
      const fullResult = await this.fullGeneration(currentCommit);
      return { ...fullResult, mode: 'incremental' };
    }

    // Add new files to nearest module or "Other"
    if (newFiles.length > 0) {
      if (!existingMeta.moduleFiles['Other']) {
        existingMeta.moduleFiles['Other'] = [];
      }
      existingMeta.moduleFiles['Other'].push(...newFiles);
      affectedModules.add('Other');
    }

    // Regenerate affected module pages (parallel)
    let pagesGenerated = 0;
    const moduleTree = existingMeta.moduleTree;
    const affectedArray = Array.from(affectedModules);

    this.onProgress('incremental', 20, `Regenerating ${affectedArray.length} module(s)...`);

    const affectedNodes: ModuleTreeNode[] = [];
    for (const mod of affectedArray) {
      const modSlug = this.slugify(mod);
      const node = this.findNodeBySlug(moduleTree, modSlug);
      if (node) {
        try { await fs.unlink(path.join(this.wikiDir, `${node.slug}.md`)); } catch {}
        affectedNodes.push(node);
      }
    }

    let incProcessed = 0;
    pagesGenerated += await this.runParallel(affectedNodes, async (node) => {
      try {
        if (node.children && node.children.length > 0) {
          await this.generateParentPage(node);
        } else {
          await this.generateLeafPage(node);
        }
        incProcessed++;
        const percent = 20 + Math.round((incProcessed / affectedNodes.length) * 60);
        this.onProgress('incremental', percent, `${incProcessed}/${affectedNodes.length} — ${node.name}`);
        return 1;
      } catch (err: any) {
        this.failedModules.push(node.name);
        incProcessed++;
        return 0;
      }
    });

    // Regenerate overview if any pages changed
    if (pagesGenerated > 0) {
      this.onProgress('incremental', 85, 'Updating overview...');
      await this.generateOverview(moduleTree);
      pagesGenerated++;
    }

    // Save updated metadata
    this.onProgress('incremental', 95, 'Saving metadata...');
    await this.saveWikiMeta({
      ...existingMeta,
      fromCommit: currentCommit,
      generatedAt: new Date().toISOString(),
      model: this.llmConfig.model,
      failedModules: this.failedModules.length > 0 ? [...this.failedModules] : undefined,
    });

    this.onProgress('done', 100, 'Incremental update complete');
    return { pagesGenerated, mode: 'incremental', failedModules: [...this.failedModules] };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private getCurrentCommit(): string {
    try {
      return execSync('git rev-parse HEAD', { cwd: this.repoPath }).toString().trim();
    } catch {
      return '';
    }
  }

  private getChangedFiles(fromCommit: string, toCommit: string): string[] {
    try {
      const output = execFileSync(
        'git', ['diff', `${fromCommit}..${toCommit}`, '--name-only'],
        { cwd: this.repoPath },
      ).toString().trim();
      return output ? output.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  private async readSourceFiles(filePaths: string[]): Promise<string> {
    const parts: string[] = [];
    for (const fp of filterWikiPromptPaths(filePaths)) {
      const fullPath = path.join(this.repoPath, fp);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        parts.push(`\n--- ${fp} ---\n${content}`);
      } catch {
        parts.push(`\n--- ${fp} ---\n(file not readable)`);
      }
    }
    return parts.join('\n');
  }

  private truncateSource(source: string, maxTokens: number): string {
    // Rough truncation: keep first maxTokens*4 chars and add notice
    const maxChars = maxTokens * 4;
    if (source.length <= maxChars) return source;
    return source.slice(0, maxChars) + '\n\n... (source truncated for context window limits)';
  }

  private async estimateModuleTokens(filePaths: string[]): Promise<number> {
    let total = 0;
    for (const fp of filterWikiPromptPaths(filePaths)) {
      try {
        const content = await fs.readFile(path.join(this.repoPath, fp), 'utf-8');
        total += estimateTokens(content);
      } catch {
        // File not readable, skip
      }
    }
    return total;
  }

  private async readProjectInfo(): Promise<string> {
    const candidates = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle'];
    const lines: string[] = [`Project: ${path.basename(this.repoPath)}`];

    for (const file of candidates) {
      const fullPath = path.join(this.repoPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        if (file === 'package.json') {
          const pkg = JSON.parse(content);
          if (pkg.name) lines.push(`Name: ${pkg.name}`);
          if (pkg.description) lines.push(`Description: ${pkg.description}`);
          if (pkg.scripts) lines.push(`Scripts: ${Object.keys(pkg.scripts).join(', ')}`);
        } else {
          // Include first 500 chars of other config files
          lines.push(`\n${file}:\n${content.slice(0, 500)}`);
        }
        break; // Use first config found
      } catch {
        continue;
      }
    }

    // Read README excerpt
    for (const readme of ['README.md', 'readme.md', 'README.txt']) {
      try {
        const content = await fs.readFile(path.join(this.repoPath, readme), 'utf-8');
        lines.push(`\nREADME excerpt:\n${content.slice(0, 1000)}`);
        break;
      } catch {
        continue;
      }
    }

    return lines.join('\n');
  }

  private assertPromptWithinBudget(prompt: string, label: string): void {
    const promptTokens = estimateTokens(prompt);
    if (promptTokens > MAX_WIKI_PROMPT_TOKENS) {
      throw new Error(`${label} prompt exceeds safe budget (${promptTokens} tokens)`);
    }
  }

  private buildDeterministicModuleTree(files: FileWithExports[]): ModuleTreeNode[] {
    const topGroups = new Map<string, string[]>();
    for (const file of files) {
      const normalized = file.filePath.replace(/\\/g, '/');
      const topLevel = normalized.split('/')[0] || 'Root';
      const group = topGroups.get(topLevel) || [];
      group.push(file.filePath);
      topGroups.set(topLevel, group);
    }

    const tree: ModuleTreeNode[] = [];
    for (const [topLevel, topFiles] of Array.from(topGroups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      const sortedTopFiles = topFiles.sort();
      const subGroups = new Map<string, string[]>();
      for (const filePath of sortedTopFiles) {
        const normalized = filePath.replace(/\\/g, '/');
        const parts = normalized.split('/');
        const subKey = parts.length > 2 ? parts.slice(0, 2).join('/') : topLevel;
        const group = subGroups.get(subKey) || [];
        group.push(filePath);
        subGroups.set(subKey, group);
      }

      const children: ModuleTreeNode[] = [];
      for (const [subKey, subFiles] of Array.from(subGroups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        const chunked = this.chunkFiles(subFiles.sort());
        chunked.forEach((chunk, index) => {
          const baseName = subKey === topLevel ? topLevel : path.basename(subKey);
          const suffix = chunked.length > 1 ? ` ${index + 1}` : '';
          children.push({
            name: `${topLevel} — ${baseName}${suffix}`,
            slug: this.slugify(`${topLevel}-${baseName}-${index + 1}`),
            files: chunk,
          });
        });
      }

      if (children.length <= 1 && sortedTopFiles.length <= MAX_FILES_PER_DETERMINISTIC_GROUP) {
        tree.push({
          name: topLevel,
          slug: this.slugify(topLevel),
          files: sortedTopFiles,
        });
        continue;
      }

      tree.push({
        name: topLevel,
        slug: this.slugify(topLevel),
        files: [],
        children,
      });
    }

    return tree;
  }

  private chunkFiles(files: string[]): string[][] {
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentPromptTokens = 0;

    for (const file of files) {
      const filePromptTokens = estimateTokens(`- ${file}: no exports\n`);
      const wouldExceedFileLimit = currentChunk.length >= MAX_FILES_PER_DETERMINISTIC_GROUP;
      const wouldExceedPromptBudget = currentChunk.length > 0
        && currentPromptTokens + filePromptTokens > MAX_GROUPING_BATCH_TOKENS;

      if (wouldExceedFileLimit || wouldExceedPromptBudget) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentPromptTokens = 0;
      }

      currentChunk.push(file);
      currentPromptTokens += filePromptTokens;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }
    return chunks;
  }

  private extractModuleFiles(tree: ModuleTreeNode[]): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const node of tree) {
      if (node.children && node.children.length > 0) {
        result[node.name] = node.children.flatMap(c => c.files);
        for (const child of node.children) {
          result[child.name] = child.files;
        }
      } else {
        result[node.name] = node.files;
      }
    }
    return result;
  }

  private countModules(tree: ModuleTreeNode[]): number {
    let count = 0;
    for (const node of tree) {
      count++;
      if (node.children) {
        count += node.children.length;
      }
    }
    return count;
  }

  /**
   * Flatten the module tree into leaf nodes and parent nodes.
   * Leaves can be processed in parallel; parents must wait for children.
   */
  private flattenModuleTree(tree: ModuleTreeNode[]): { leaves: ModuleTreeNode[]; parents: ModuleTreeNode[] } {
    const leaves: ModuleTreeNode[] = [];
    const parents: ModuleTreeNode[] = [];

    for (const node of tree) {
      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          leaves.push(child);
        }
        parents.push(node);
      } else {
        leaves.push(node);
      }
    }

    return { leaves, parents };
  }

  /**
   * Run async tasks in parallel with a concurrency limit and adaptive rate limiting.
   * If a 429 rate limit is hit, concurrency is temporarily reduced.
   */
  private async runParallel<T>(
    items: T[],
    fn: (item: T) => Promise<number>,
  ): Promise<number> {
    let total = 0;
    let activeConcurrency = this.concurrency;
    let running = 0;
    let idx = 0;

    return new Promise((resolve, reject) => {
      const next = () => {
        while (running < activeConcurrency && idx < items.length) {
          const item = items[idx++];
          running++;

          fn(item)
            .then((count) => {
              total += count;
              running--;
              if (idx >= items.length && running === 0) {
                resolve(total);
              } else {
                next();
              }
            })
            .catch((err) => {
              running--;
              // On rate limit, reduce concurrency temporarily
              if (err.message?.includes('429')) {
                activeConcurrency = Math.max(1, activeConcurrency - 1);
                this.onProgress('modules', this.lastPercent, `Rate limited — concurrency → ${activeConcurrency}`);
                // Re-queue the item
                idx--;
                setTimeout(next, 5000);
              } else {
                if (idx >= items.length && running === 0) {
                  resolve(total);
                } else {
                  next();
                }
              }
            });
        }
      };

      if (items.length === 0) {
        resolve(0);
      } else {
        next();
      }
    });
  }

  private findNodeBySlug(tree: ModuleTreeNode[], slug: string): ModuleTreeNode | null {
    for (const node of tree) {
      if (node.slug === slug) return node;
      if (node.children) {
        const found = this.findNodeBySlug(node.children, slug);
        if (found) return found;
      }
    }
    return null;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  private async fileExists(fp: string): Promise<boolean> {
    try {
      await fs.access(fp);
      return true;
    } catch {
      return false;
    }
  }

  private async loadWikiMeta(): Promise<WikiMeta | null> {
    try {
      const raw = await fs.readFile(path.join(this.wikiDir, 'meta.json'), 'utf-8');
      return JSON.parse(raw) as WikiMeta;
    } catch {
      return null;
    }
  }

  private async saveWikiMeta(meta: WikiMeta): Promise<void> {
    await fs.writeFile(
      path.join(this.wikiDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  private async saveModuleTree(tree: ModuleTreeNode[]): Promise<void> {
    await fs.writeFile(
      path.join(this.wikiDir, 'module_tree.json'),
      JSON.stringify(tree, null, 2),
      'utf-8',
    );
  }
}
