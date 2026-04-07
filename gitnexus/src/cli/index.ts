#!/usr/bin/env node

// Heap re-spawn removed — only analyze.ts needs the 8GB heap (via its own ensureHeap()).
// Removing it from here improves MCP server startup time significantly.

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { createLazyAction } from './lazy-action.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');
const program = new Command();

program
  .name('gitnexus')
  .description('GitNexus local CLI and MCP server')
  .version(pkg.version);

program
  .command('setup')
  .description('One-time setup: configure MCP for Cursor, Claude Code, OpenCode')
  .action(createLazyAction(() => import('./setup.js'), 'setupCommand'));

program
  .command('analyze [path]')
  .description('Index a repository (full analysis)')
  .option('-f, --force', 'Force full re-index even if up to date')
  .option('--embeddings', 'Enable embedding generation for semantic search (off by default)')
  .option('--skills', 'Generate repo-specific skill files from detected communities')
   .option('-v, --verbose', 'Enable verbose ingestion warnings (default: false)')
   .addHelpText('after', '\nEnvironment variables:\n  GITNEXUS_NO_GITIGNORE=1  Skip .gitignore parsing (still reads .gitnexusignore)')
   .action(createLazyAction(() => import('./analyze.js'), 'analyzeCommand'));

program
  .command('serve')
  .description('Start local HTTP server for web UI connection')
  .option('-p, --port <port>', 'Port number', '4747')
  .option('--host <host>', 'Bind address (default: 127.0.0.1, use 0.0.0.0 for remote access)')
  .action(createLazyAction(() => import('./serve.js'), 'serveCommand'));

program
  .command('mcp')
  .description('Start MCP server (stdio) — serves all indexed repos')
  .action(createLazyAction(() => import('./mcp.js'), 'mcpCommand'));

program
  .command('list')
  .description('List all indexed repositories')
  .action(createLazyAction(() => import('./list.js'), 'listCommand'));

program
  .command('status')
  .description('Show index status for current repo')
  .action(createLazyAction(() => import('./status.js'), 'statusCommand'));

program
  .command('clean')
  .description('Delete GitNexus index for current repo')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--all', 'Clean all indexed repos')
  .action(createLazyAction(() => import('./clean.js'), 'cleanCommand'));

program
  .command('wiki [path]')
  .description('Generate repository wiki from knowledge graph')
  .option('-f, --force', 'Force full regeneration even if up to date')
  .option('--model <model>', 'LLM model name (default: minimax/minimax-m2.5)')
  .option('--base-url <url>', 'LLM API base URL (default: OpenAI)')
  .option('--api-key <key>', 'LLM API key (saved to ~/.gitnexus/config.json)')
  .option('--concurrency <n>', 'Parallel LLM calls (default: 3)', '3')
  .option('--gist', 'Publish wiki as a public GitHub Gist after generation')
  .option('--exclude <patterns>', 'Comma-separated directory patterns to exclude (saved for future runs)')
  .action(createLazyAction(() => import('./wiki.js'), 'wikiCommand'));

program
  .command('sipher-patched [path]')
  .description('Validate S2 repo shape and Sipher gateway env for wiki generation')
  .action(createLazyAction(() => import('./sipher-patched.js'), 'sipherPatchedCommand'));

program
  .command('augment <pattern>')
  .description('Augment a search pattern with knowledge graph context (used by hooks)')
  .action(createLazyAction(() => import('./augment.js'), 'augmentCommand'));

// ─── Direct Tool Commands (no MCP overhead) ────────────────────────
// These invoke LocalBackend directly for use in eval, scripts, and CI.

program
  .command('query <search_query>')
  .description('Search the knowledge graph for execution flows related to a concept')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'What you want to find')
  .option('-l, --limit <n>', 'Max processes to return (default: 5)')
  .option('--content', 'Include full symbol source code')
  .action(createLazyAction(() => import('./tool.js'), 'queryCommand'));

program
  .command('context [name]')
  .description('360-degree view of a code symbol: callers, callees, processes')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('--content', 'Include full symbol source code')
  .action(createLazyAction(() => import('./tool.js'), 'contextCommand'));

program
  .command('impact <target>')
  .description('Blast radius analysis: what breaks if you change a symbol')
  .option('-d, --direction <dir>', 'upstream (dependants) or downstream (dependencies)', 'upstream')
  .option('-r, --repo <name>', 'Target repository')
  .option('--depth <n>', 'Max relationship depth (default: 3)')
  .option('--include-tests', 'Include test files in results')
  .action(createLazyAction(() => import('./tool.js'), 'impactCommand'));

program
  .command('cypher <query>')
  .description('Execute raw Cypher query against the knowledge graph')
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./tool.js'), 'cypherCommand'));

// ─── Unreal Engine Namespace ───────────────────────────────────────────

const unrealCmd = program
  .command('unreal')
  .description('Unreal Engine project management');

unrealCmd
  .command('setup')
  .description('Full setup: install plugin, build editor target, sync Blueprint assets')
  .option('--project <path>', 'UE project root (default: current directory)')
  .option('--editor-cmd <path>', 'Path to UnrealEditor-Cmd.exe (auto-detected if omitted)')
  .option('--force', 'Overwrite existing plugin/config if present')
  .action(createLazyAction(() => import('./unreal.js'), 'unrealSetupCommand'));

unrealCmd
  .command('init')
  .description('Validate UE project and configure GitNexus integration')
  .option('--project <path>', 'UE project root (default: current directory)')
  .option('--editor-cmd <path>', 'Path to UnrealEditor-Cmd.exe (auto-detected if omitted)')
  .action(createLazyAction(() => import('./unreal.js'), 'unrealInitCommand'));

unrealCmd
  .command('sync')
  .description('Sync Unreal Blueprint assets into the knowledge graph')
  .option('--deep', 'Deep mode: fully load Blueprints for function refs (slower)')
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./unreal.js'), 'unrealSyncCommand'));

unrealCmd
  .command('status')
  .description('Show Unreal asset index status and freshness')
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./unreal.js'), 'unrealStatusCommand'));

program
  .command('unreal-sync')
  .description('Refresh the Unreal Blueprint asset manifest for the current indexed repo')
  .option('-r, --repo <name>', 'Target repository')
  .option('--deep', 'Deep mode: load Blueprints fully for native_function_refs (slower, higher memory)')
  .action(createLazyAction(() => import('./tool.js'), 'syncUnrealAssetManifestCommand'));

program
  .command('unreal-find-refs [functionName]')
  .description('Find confirmed Blueprint references to a native C++ function via the Unreal analyzer')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-c, --class-name <name>', 'Owning native class name')
  .option('-f, --file <path>', 'Source file path to disambiguate the function')
  .option('--refresh-manifest', 'Refresh the Unreal asset manifest before searching')
  .option('--max-candidates <n>', 'Cap the Blueprint candidate set passed to the Unreal analyzer')
  .action(createLazyAction(() => import('./tool.js'), 'findNativeBlueprintReferencesCommand'));

program
  .command('unreal-expand-chain <assetPath> <chainAnchorId>')
  .description('Expand a Blueprint chain from a confirmed Unreal reference anchor')
  .option('-r, --repo <name>', 'Target repository')
  .option('-d, --direction <dir>', 'upstream or downstream', 'downstream')
  .option('--depth <n>', 'Maximum Blueprint traversal depth')
  .action(createLazyAction(() => import('./tool.js'), 'expandBlueprintChainCommand'));

program
  .command('unreal-derived-blueprints <className>')
  .description('List Blueprint assets derived from a native C++ class via the Unreal manifest')
  .option('-r, --repo <name>', 'Target repository')
  .option('--refresh-manifest', 'Refresh the Unreal asset manifest before searching')
  .option('--max-results <n>', 'Maximum Blueprint assets to return')
  .action(createLazyAction(() => import('./tool.js'), 'findBlueprintsDerivedFromNativeClassCommand'));

// ─── Info Commands ──────────────────────────────────────────────────

program
  .command('changelog')
  .alias('changelogs')
  .description('Show release notes and version history')
  .option('-v, --version <version>', 'Show notes for a specific version (e.g. 1.3.0)')
  .option('-a, --all', 'Show all versions')
  .action(createLazyAction(() => import('./changelog.js'), 'changelogCommand'));

// ─── Eval Server (persistent daemon for SWE-bench) ─────────────────

program
  .command('eval-server')
  .description('Start lightweight HTTP server for fast tool calls during evaluation')
  .option('-p, --port <port>', 'Port number', '4848')
  .option('--idle-timeout <seconds>', 'Auto-shutdown after N seconds idle (0 = disabled)', '0')
  .action(createLazyAction(() => import('./eval-server.js'), 'evalServerCommand'));

program.parse(process.argv);
