import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

const { callLLM } = vi.hoisted(() => ({
  callLLM: vi.fn(),
}));

vi.mock('../../src/core/wiki/llm-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/wiki/llm-client.js')>('../../src/core/wiki/llm-client.js');
  return {
    ...actual,
    callLLM,
  };
});

import { WikiGenerator, selectFilesForInitialGrouping } from '../../src/core/wiki/generator.js';

describe('wiki generator helpers', () => {
  let tmpHandle: TestDBHandle;

  beforeEach(async () => {
    callLLM.mockReset();
    tmpHandle = await createTempDir('gitnexus-wiki-generator-');
  });

  afterEach(async () => {
    await tmpHandle.cleanup();
  });

  it('prefers exported files for the initial grouping pass', () => {
    const selected = selectFilesForInitialGrouping(
      [
        { filePath: 'Source/S2/GameMode.cpp', symbols: [{ name: 'GameMode', type: 'Class' }] },
      ],
      [
        'Source/S2/GameMode.cpp',
        'Content/Maps/Main.umap',
        'Source/S2/Enemy.cpp',
      ],
    );

    expect(selected).toEqual([
      { filePath: 'Source/S2/GameMode.cpp', symbols: [{ name: 'GameMode', type: 'Class' }] },
    ]);
  });

  it('falls back to all non-ignored files when no exported files exist', () => {
    const selected = selectFilesForInitialGrouping([], [
      'Source/S2/GameMode.cpp',
      'Content/Maps/Main.umap',
      'Source/S2/Enemy.cpp',
    ]);

    expect(selected).toEqual([
      { filePath: 'Source/S2/GameMode.cpp', symbols: [] },
      { filePath: 'Source/S2/Enemy.cpp', symbols: [] },
    ]);
  });

  it('reuses an existing module tree snapshot instead of calling the LLM', async () => {
    const repoPath = tmpHandle.dbPath;
    const storagePath = path.join(repoPath, '.gitnexus');
    const wikiDir = path.join(storagePath, 'wiki');
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.writeFile(
      path.join(wikiDir, 'first_module_tree.json'),
      JSON.stringify([{ name: 'Source', slug: 'source', files: ['Source/S2/GameMode.cpp'] }], null, 2),
      'utf-8',
    );

    const generator = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      {
        apiKey: 'key',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-5.4-mini',
        maxTokens: 100,
        temperature: 0,
      },
    );

    const tree = await (generator as any).buildModuleTree([
      { filePath: 'Source/S2/GameMode.cpp', symbols: [] },
    ]);

    expect(tree).toEqual([{ name: 'Source', slug: 'source', files: ['Source/S2/GameMode.cpp'] }]);
    expect(callLLM).not.toHaveBeenCalled();
  });
});
