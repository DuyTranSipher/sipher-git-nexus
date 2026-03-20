import fs from 'fs/promises';
import path from 'path';
import { getGitRoot, isGitRepo } from '../storage/git.js';
import { resolveLLMConfig } from '../core/wiki/llm-client.js';

const REQUIRED_GATEWAY_ENV_VARS = [
  'AI_GATEWAY_API_KEY',
  'AI_GATEWAY_CREDENTIAL',
  'AI_GATEWAY_GROUP',
] as const;

function maskValue(value: string): string {
  if (!value) return '(missing)';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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

export const sipherPatchedCommand = async (inputPath?: string) => {
  console.log('\n  GitNexus Sipher Gateway Preflight\n');

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
    console.log('  Use `gitnexus wiki` directly for non-S2 repositories.\n');
    process.exitCode = 1;
    return;
  }

  const llmConfig = await resolveLLMConfig();
  const missingGatewayVars = REQUIRED_GATEWAY_ENV_VARS.filter(name => !process.env[name]);

  console.log(`  Repo: ${repoPath}`);
  console.log(`  Base URL: ${llmConfig.baseUrl}`);
  console.log(`  Model: ${llmConfig.model}`);
  console.log(`  Authorization: ${llmConfig.apiKey ? `Bearer ${maskValue(llmConfig.apiKey)}` : '(missing)'}\n`);

  console.log('  Gateway headers:');
  for (const name of REQUIRED_GATEWAY_ENV_VARS) {
    const value = process.env[name];
    console.log(`    - ${name}: ${value ? maskValue(value) : '(missing)'}`);
  }
  console.log('');

  if (missingGatewayVars.length > 0) {
    console.log(`  Error: Missing required Sipher gateway env vars: ${missingGatewayVars.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  console.log('  Preflight OK. `gitnexus wiki` can use the current Sipher gateway environment.\n');
};
