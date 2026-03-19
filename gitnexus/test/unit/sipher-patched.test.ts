import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  analyzeCommand,
  wikiCommand,
  initWikiDb,
  getFilesWithExports,
  closeWikiDb,
} = vi.hoisted(() => ({
  analyzeCommand: vi.fn(),
  wikiCommand: vi.fn(),
  initWikiDb: vi.fn(),
  getFilesWithExports: vi.fn(),
  closeWikiDb: vi.fn(),
}));

vi.mock('../../src/cli/analyze.js', () => ({
  analyzeCommand,
}));

vi.mock('../../src/cli/wiki.js', () => ({
  wikiCommand,
}));

vi.mock('../../src/core/wiki/graph-queries.js', () => ({
  initWikiDb,
  getFilesWithExports,
  closeWikiDb,
}));

import { sipherPatchedCommand } from '../../src/cli/sipher-patched.js';

async function initGitRepo(repoPath: string): Promise<void> {
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test\n', 'utf-8');
  spawnSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: repoPath, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repoPath, stdio: 'pipe' });
  spawnSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'pipe' });
}

async function createRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-sipher-'));
}

async function createS2Markers(repoPath: string): Promise<void> {
  await fs.mkdir(path.join(repoPath, 'Source'), { recursive: true });
  await fs.writeFile(path.join(repoPath, 'S2.uproject'), '{}', 'utf-8');
  await fs.writeFile(path.join(repoPath, 'Source', 'S2.Target.cs'), '// target', 'utf-8');
}

async function writeMeta(repoPath: string, lastCommit: string, embeddings = 0): Promise<void> {
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(path.join(storagePath, 'lbug'), '', 'utf-8');
  await fs.writeFile(
    path.join(storagePath, 'meta.json'),
    JSON.stringify({
      repoPath,
      lastCommit,
      indexedAt: new Date().toISOString(),
      stats: { embeddings },
    }, null, 2),
    'utf-8',
  );
}

describe('sipher-patched command', () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    analyzeCommand.mockReset();
    wikiCommand.mockReset();
    initWikiDb.mockReset();
    getFilesWithExports.mockReset();
    closeWikiDb.mockReset();

    analyzeCommand.mockImplementation(async (repoPath: string) => {
      const storagePath = path.join(repoPath, '.gitnexus');
      await fs.mkdir(storagePath, { recursive: true });
      await fs.writeFile(path.join(storagePath, 'lbug'), '', 'utf-8');
    });
    wikiCommand.mockResolvedValue(undefined);
    initWikiDb.mockResolvedValue(undefined);
    closeWikiDb.mockResolvedValue(undefined);
    getFilesWithExports.mockResolvedValue([
      { filePath: 'Source/S2/GameMode.cpp', symbols: [{ name: 'GameMode', type: 'Class' }] },
      { filePath: 'Source/S2/Enemy.cpp', symbols: [{ name: 'Enemy', type: 'Class' }] },
    ]);
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('rejects non-S2 repositories', async () => {
    const repoPath = await createRepo();
    try {
      await initGitRepo(repoPath);

      await sipherPatchedCommand(repoPath, {});

      expect(process.exitCode).toBe(1);
      expect(analyzeCommand).not.toHaveBeenCalled();
      expect(wikiCommand).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('skips analyze when the current S2 index is up to date', async () => {
    const repoPath = await createRepo();
    try {
      await createS2Markers(repoPath);
      await initGitRepo(repoPath);
      const currentCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).stdout.trim();
      await writeMeta(repoPath, currentCommit);

      await sipherPatchedCommand(repoPath, {});

      expect(analyzeCommand).not.toHaveBeenCalled();
      expect(wikiCommand).toHaveBeenCalledTimes(1);
      const [calledRepoPath, wikiOptions] = wikiCommand.mock.calls[0];
      expect((calledRepoPath as string).toLowerCase()).toContain(path.basename(repoPath).toLowerCase());
      expect(wikiOptions).toMatchObject({
        baseUrl: 'https://ai-gateway.atherlabs.com/v1',
        persistConfig: false,
      });
      const snapshot = JSON.parse(await fs.readFile(path.join(repoPath, '.gitnexus', 'wiki', 'first_module_tree.json'), 'utf-8'));
      expect(snapshot).toHaveLength(1);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('runs analyze when the index is missing', async () => {
    const repoPath = await createRepo();
    try {
      await createS2Markers(repoPath);
      await initGitRepo(repoPath);

      await sipherPatchedCommand(repoPath, {});

      const [calledRepoPath, analyzeOptions] = analyzeCommand.mock.calls[0];
      expect((calledRepoPath as string).toLowerCase()).toContain(path.basename(repoPath).toLowerCase());
      expect(analyzeOptions).toMatchObject({
        embeddings: false,
      });
      expect(wikiCommand).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('runs analyze with embeddings preserved when the index is stale', async () => {
    const repoPath = await createRepo();
    try {
      await createS2Markers(repoPath);
      await initGitRepo(repoPath);
      await writeMeta(repoPath, 'stale-commit', 42);

      await sipherPatchedCommand(repoPath, {});

      const [calledRepoPath, analyzeOptions] = analyzeCommand.mock.calls[0];
      expect((calledRepoPath as string).toLowerCase()).toContain(path.basename(repoPath).toLowerCase());
      expect(analyzeOptions).toMatchObject({
        embeddings: true,
      });
      expect(wikiCommand).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('regenerates the snapshot on force', async () => {
    const repoPath = await createRepo();
    try {
      await createS2Markers(repoPath);
      await initGitRepo(repoPath);
      const currentCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).stdout.trim();
      await writeMeta(repoPath, currentCommit);
      const wikiDir = path.join(repoPath, '.gitnexus', 'wiki');
      await fs.mkdir(wikiDir, { recursive: true });
      await fs.writeFile(path.join(wikiDir, 'first_module_tree.json'), JSON.stringify([{ name: 'Old', slug: 'old', files: [] }]), 'utf-8');

      await sipherPatchedCommand(repoPath, { force: true });

      const [calledRepoPath, analyzeOptions] = analyzeCommand.mock.calls[0];
      expect((calledRepoPath as string).toLowerCase()).toContain(path.basename(repoPath).toLowerCase());
      expect(analyzeOptions).toMatchObject({
        force: true,
      });
      const snapshot = JSON.parse(await fs.readFile(path.join(wikiDir, 'first_module_tree.json'), 'utf-8'));
      expect(snapshot).not.toEqual([{ name: 'Old', slug: 'old', files: [] }]);
      expect(wikiCommand).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});
