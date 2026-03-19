import fs from 'fs/promises';
import path from 'path';
import { analyzeCommand } from './analyze.js';
import { wikiCommand, type WikiCommandOptions } from './wiki.js';
import { shouldIgnorePath } from '../config/ignore-service.js';
import {
  initWikiDb,
  getFilesWithExports,
  closeWikiDb,
  type FileWithExports,
} from '../core/wiki/graph-queries.js';
import type { ModuleTreeNode } from '../core/wiki/generator.js';
import { getCurrentCommit, getGitRoot, isGitRepo } from '../storage/git.js';
import { getStoragePaths, loadMeta } from '../storage/repo-manager.js';

const S2_DEFAULT_BASE_URL = 'https://ai-gateway.atherlabs.com/v1';
const SNAPSHOT_FILE = 'first_module_tree.json';
const NESTING_THRESHOLD = 200;

export interface SipherPatchedOptions {
  force?: boolean;
  embeddings?: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  concurrency?: string;
  gist?: boolean;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'module';
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function isS2Repo(repoPath: string): Promise<boolean> {
  const hasProject = await pathExists(path.join(repoPath, 'S2.uproject'));
  const hasTarget = await pathExists(path.join(repoPath, 'Source', 'S2.Target.cs'));
  const hasEditorTarget = await pathExists(path.join(repoPath, 'Source', 'S2Editor.Target.cs'));
  return hasProject && (hasTarget || hasEditorTarget);
}

export function buildS2ModuleTree(files: FileWithExports[]): ModuleTreeNode[] {
  const topGroups = new Map<string, string[]>();
  for (const file of files) {
    const normalized = file.filePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const top = parts[0] || 'Root';
    const group = topGroups.get(top) || [];
    group.push(file.filePath);
    topGroups.set(top, group);
  }

  const tree: ModuleTreeNode[] = [];
  for (const [top, groupFiles] of Array.from(topGroups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const subgroups = new Map<string, string[]>();
    for (const filePath of groupFiles) {
      const parts = filePath.replace(/\\/g, '/').split('/');
      const subgroupKey = parts.length > 1 ? parts.slice(0, 2).join('/') : top;
      const group = subgroups.get(subgroupKey) || [];
      group.push(filePath);
      subgroups.set(subgroupKey, group);
    }

    const shouldNest = groupFiles.length > NESTING_THRESHOLD && subgroups.size > 1;
    if (shouldNest) {
      const children = Array.from(subgroups.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([subgroupKey, subgroupFiles]) => {
          const childName = subgroupKey === top ? top : path.posix.basename(subgroupKey);
          return {
            name: `${top} - ${childName}`,
            slug: slugify(`${top}-${childName}`),
            files: subgroupFiles,
          };
        });

      tree.push({
        name: top,
        slug: slugify(top),
        files: [],
        children,
      });
      continue;
    }

    tree.push({
      name: top,
      slug: slugify(top),
      files: groupFiles,
    });
  }

  return tree;
}

function countLeafModules(tree: ModuleTreeNode[]): number {
  return tree.reduce((count, node) => count + (node.children ? node.children.length : 1), 0);
}

export async function ensureS2Snapshot(repoPath: string, force = false): Promise<string> {
  const { storagePath, lbugPath } = getStoragePaths(repoPath);
  const wikiDir = path.join(storagePath, 'wiki');
  const snapshotPath = path.join(wikiDir, SNAPSHOT_FILE);

  if (!force && await pathExists(snapshotPath)) {
    return snapshotPath;
  }

  if (!await pathExists(lbugPath)) {
    throw new Error('No GitNexus index found. Run `gitnexus analyze` first.');
  }

  await initWikiDb(lbugPath);
  try {
    const files = (await getFilesWithExports()).filter(file => !shouldIgnorePath(file.filePath));
    if (files.length === 0) {
      throw new Error('No exported source files found for S2 snapshot generation.');
    }

    const tree = buildS2ModuleTree(files);
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.writeFile(snapshotPath, JSON.stringify(tree, null, 2), 'utf-8');

    console.log(`  Prepared S2 module tree (${tree.length} top-level, ${countLeafModules(tree)} leaf modules)`);
    return snapshotPath;
  } finally {
    await closeWikiDb();
  }
}

export const sipherPatchedCommand = async (
  inputPath?: string,
  options?: SipherPatchedOptions,
) => {
  console.log('\n  GitNexus Sipher-Patched\n');

  let repoPath: string;
  if (inputPath) {
    const resolved = path.resolve(inputPath);
    repoPath = getGitRoot(resolved) || resolved;
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      console.log('  Error: Not inside a git repository\n');
      process.exitCode = 1;
      return;
    }
    repoPath = gitRoot;
  }

  if (!isGitRepo(repoPath)) {
    console.log('  Error: Not a git repository\n');
    process.exitCode = 1;
    return;
  }

  if (!await isS2Repo(repoPath)) {
    console.log('  Error: `gitnexus sipher-patched` only supports the S2 repository shape.');
    console.log('  Use `gitnexus analyze` and `gitnexus wiki` for other repositories.\n');
    process.exitCode = 1;
    return;
  }

  const { storagePath } = getStoragePaths(repoPath);
  const currentCommit = getCurrentCommit(repoPath);
  const existingMeta = await loadMeta(storagePath);
  const needsAnalyze = !existingMeta || options?.force || existingMeta.lastCommit !== currentCommit;

  if (needsAnalyze) {
    const preserveEmbeddings = (existingMeta?.stats?.embeddings ?? 0) > 0;
    await analyzeCommand(repoPath, {
      force: options?.force,
      embeddings: !!options?.embeddings || preserveEmbeddings,
    });
    if (process.exitCode && process.exitCode !== 0) return;
  }

  await ensureS2Snapshot(repoPath, !!options?.force);

  const hasExplicitWikiOverrides = !!(options?.apiKey || options?.model || options?.baseUrl);
  const wikiOptions: WikiCommandOptions = {
    force: options?.force,
    model: options?.model,
    baseUrl: options?.baseUrl ?? S2_DEFAULT_BASE_URL,
    apiKey: options?.apiKey,
    concurrency: options?.concurrency,
    gist: options?.gist,
    persistConfig: hasExplicitWikiOverrides,
  };

  await wikiCommand(repoPath, wikiOptions);
};
