import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  MAX_WIKI_PROMPT_TOKENS,
  WikiGenerator,
  estimateGroupingPromptTokens,
  shouldUseDeterministicGrouping,
} from '../../src/core/wiki/generator.js';

describe('wiki generator grouping', () => {
  beforeEach(() => {
    callLLM.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses LLM grouping for small repositories', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-small-'));
    try {
      await fs.mkdir(path.join(repoPath, '.gitnexus', 'wiki'), { recursive: true });
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
      callLLM.mockResolvedValue({
        content: JSON.stringify({
          Gameplay: [
            'Source/S2/GameMode.cpp',
            'Source/S2/Enemy.cpp',
          ],
        }),
      });

      const tree = await (generator as any).buildModuleTree([
        { filePath: 'Source/S2/GameMode.cpp', symbols: [] },
        { filePath: 'Source/S2/Enemy.cpp', symbols: [] },
      ]);

      expect(callLLM).toHaveBeenCalledTimes(1);
      expect(tree).toEqual([
        {
          name: 'Gameplay',
          slug: 'gameplay',
          files: ['Source/S2/GameMode.cpp', 'Source/S2/Enemy.cpp'],
        },
      ]);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('switches to deterministic grouping when the grouping prompt is oversized', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-large-'));
    try {
      await fs.mkdir(path.join(repoPath, '.gitnexus', 'wiki'), { recursive: true });
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

      const files = Array.from({ length: 2501 }, (_, index) => ({
        filePath: `Plugins/Gameplay/Private/System${index}.cpp`,
        symbols: [],
      }));
      const promptTokens = estimateGroupingPromptTokens(files);

      expect(shouldUseDeterministicGrouping(files.length, promptTokens)).toBe(true);

      const tree = await (generator as any).buildModuleTree(files);

      expect(callLLM).not.toHaveBeenCalled();
      expect(tree).toHaveLength(1);
      expect(tree[0].name).toBe('Plugins');
      expect(tree[0].children?.length).toBeGreaterThan(1);
      tree[0].children?.forEach((child: { files: string[] }) => {
        expect(child.files.length).toBeLessThanOrEqual(250);
      });
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('flags oversized grouping prompts before they are sent', () => {
    const files = Array.from({ length: 4000 }, (_, index) => ({
      filePath: `Plugins/Gameplay/Private/${'VeryLongSystemName'.repeat(12)}${index}.cpp`,
      symbols: [{ name: `System${index}`, type: 'Class' }],
    }));

    const promptTokens = estimateGroupingPromptTokens(files);

    expect(promptTokens).toBeGreaterThan(MAX_WIKI_PROMPT_TOKENS);
    expect(shouldUseDeterministicGrouping(files.length, promptTokens)).toBe(true);
  });
});
