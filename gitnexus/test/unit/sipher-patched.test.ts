import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveLLMConfig } = vi.hoisted(() => ({
  resolveLLMConfig: vi.fn(),
}));

vi.mock('../../src/core/wiki/llm-client.js', () => ({
  resolveLLMConfig,
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

describe('sipher-patched command', () => {
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
    process.env = { ...originalEnv };
    resolveLLMConfig.mockReset();
    resolveLLMConfig.mockResolvedValue({
      apiKey: 'gateway-api-key',
      baseUrl: 'https://ai-gateway.atherlabs.com/v1',
      model: 'openai/gpt-4.1-mini',
      maxTokens: 16384,
      temperature: 0,
      gatewayApiKey: 'gateway-api-key',
      gatewayCredential: 'credential-secret',
      gatewayGroup: 'group-secret',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('reports resolved config for a valid S2 repo with gateway env present', async () => {
    const repoPath = await createRepo();
    try {
      await createS2Markers(repoPath);
      await initGitRepo(repoPath);
      process.env.AI_GATEWAY_API_KEY = 'gateway-api-key';
      process.env.AI_GATEWAY_CREDENTIAL = 'credential-secret';
      process.env.AI_GATEWAY_GROUP = 'group-secret';

      await sipherPatchedCommand(repoPath);

      expect(process.exitCode).toBeUndefined();
      expect(resolveLLMConfig).toHaveBeenCalledTimes(1);
      const output = vi.mocked(console.log).mock.calls.flat().join('\n');
      expect(output).toContain('Base URL: https://ai-gateway.atherlabs.com/v1');
      expect(output).toContain('Model: openai/gpt-4.1-mini');
      expect(output).toContain('AI_GATEWAY_API_KEY: gate');
      expect(output).toContain('Preflight OK');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('fails when required gateway env vars are missing', async () => {
    const repoPath = await createRepo();
    try {
      await createS2Markers(repoPath);
      await initGitRepo(repoPath);
      delete process.env.AI_GATEWAY_API_KEY;
      delete process.env.AI_GATEWAY_CREDENTIAL;
      delete process.env.AI_GATEWAY_GROUP;

      await sipherPatchedCommand(repoPath);

      expect(process.exitCode).toBe(1);
      const output = vi.mocked(console.log).mock.calls.flat().join('\n');
      expect(output).toContain('Missing required Sipher gateway env vars');
      expect(output).toContain('AI_GATEWAY_API_KEY');
      expect(output).toContain('AI_GATEWAY_CREDENTIAL');
      expect(output).toContain('AI_GATEWAY_GROUP');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('rejects non-S2 repositories', async () => {
    const repoPath = await createRepo();
    try {
      await initGitRepo(repoPath);

      await sipherPatchedCommand(repoPath);

      expect(process.exitCode).toBe(1);
      expect(resolveLLMConfig).not.toHaveBeenCalled();
      const output = vi.mocked(console.log).mock.calls.flat().join('\n');
      expect(output).toContain('only supports the S2 repository shape');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});
