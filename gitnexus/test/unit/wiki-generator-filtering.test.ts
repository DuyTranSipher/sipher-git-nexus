import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WikiGenerator, filterWikiPromptPaths, isWikiCodeFilePath, isWikiPromptExcludedPath } from '../../src/core/wiki/generator.js';

describe('wiki generator filtering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps wiki prompts code-centric while excluding uasset and umap files', () => {
    expect(isWikiPromptExcludedPath('Content/Maps/Main.umap')).toBe(true);
    expect(isWikiPromptExcludedPath('Content/Characters/Hero.uasset')).toBe(true);
    expect(isWikiCodeFilePath('Source/S2/GameMode.cpp')).toBe(true);
    expect(isWikiCodeFilePath('Plugins/Game/Private/AbilitySystem.h')).toBe(true);
    expect(isWikiCodeFilePath('README.md')).toBe(false);
    expect(isWikiCodeFilePath('Config/DefaultGame.ini')).toBe(false);
    expect(isWikiCodeFilePath('docs/gameplay.json')).toBe(false);
    expect(isWikiPromptExcludedPath('Source/S2/GameMode.cpp')).toBe(false);
    expect(filterWikiPromptPaths([
      'Source/S2/GameMode.cpp',
      'README.md',
      'Config/DefaultGame.ini',
      'Content/Maps/Main.umap',
      'Content/Characters/Hero.uasset',
      'Source/S2/Enemy.cpp',
    ])).toEqual([
      'Source/S2/GameMode.cpp',
      'Source/S2/Enemy.cpp',
    ]);
  });

  it('skips excluded files when reading source and estimating tokens', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-filter-'));
    try {
      await fs.mkdir(path.join(repoPath, 'Source', 'S2'), { recursive: true });
      await fs.mkdir(path.join(repoPath, 'Content', 'Maps'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'Source', 'S2', 'GameMode.cpp'), 'class AGameMode {}', 'utf-8');
      await fs.writeFile(path.join(repoPath, 'Content', 'Maps', 'Main.umap'), 'binary-ish', 'utf-8');

      const generator = new WikiGenerator(
        repoPath,
        path.join(repoPath, '.gitnexus'),
        path.join(repoPath, '.gitnexus', 'lbug'),
        {
          apiKey: 'key',
          baseUrl: 'https://example.com/v1',
          model: 'test-model',
          maxTokens: 1000,
          temperature: 0,
        },
      );

      const source = await (generator as any).readSourceFiles([
        'Source/S2/GameMode.cpp',
        'Content/Maps/Main.umap',
      ]);
      const tokens = await (generator as any).estimateModuleTokens([
        'Source/S2/GameMode.cpp',
        'README.md',
        'Content/Maps/Main.umap',
      ]);

      expect(source).toContain('GameMode.cpp');
      expect(source).not.toContain('README.md');
      expect(source).not.toContain('Main.umap');
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBe(Math.ceil('class AGameMode {}'.length / 4));
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('does not reintroduce excluded files during incremental detection', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-incremental-'));
    try {
      const generator = new WikiGenerator(
        repoPath,
        path.join(repoPath, '.gitnexus'),
        path.join(repoPath, '.gitnexus', 'lbug'),
        {
          apiKey: 'key',
          baseUrl: 'https://example.com/v1',
          model: 'test-model',
          maxTokens: 1000,
          temperature: 0,
        },
      );

      await fs.mkdir(path.join(repoPath, '.gitnexus', 'wiki'), { recursive: true });

      vi.spyOn(generator as any, 'getChangedFiles').mockReturnValue([
        'Content/Maps/Main.umap',
        'Content/Characters/Hero.uasset',
      ]);
      const saveWikiMeta = vi.spyOn(generator as any, 'saveWikiMeta').mockResolvedValue(undefined);

      const existingMeta = {
        fromCommit: 'abc123',
        generatedAt: new Date().toISOString(),
        model: 'test-model',
        moduleFiles: {
          Gameplay: ['Source/S2/GameMode.cpp'],
        },
        moduleTree: [
          { name: 'Gameplay', slug: 'gameplay', files: ['Source/S2/GameMode.cpp'] },
        ],
      };

      const result = await (generator as any).incrementalUpdate(existingMeta, 'def456');

      expect(result.pagesGenerated).toBe(0);
      expect(existingMeta.moduleFiles).toEqual({
        Gameplay: ['Source/S2/GameMode.cpp'],
      });
      expect(saveWikiMeta).toHaveBeenCalledWith(expect.objectContaining({
        moduleFiles: {
          Gameplay: ['Source/S2/GameMode.cpp'],
        },
      }));
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});
