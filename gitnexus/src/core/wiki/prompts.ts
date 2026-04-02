/**
 * LLM Prompt Templates for Wiki Generation
 * 
 * All prompts produce deterministic, source-grounded documentation.
 * Templates use {{PLACEHOLDER}} substitution.
 */

// ─── Grouping Prompt ──────────────────────────────────────────────────

export const GROUPING_SYSTEM_PROMPT = `You are a documentation architect. Given a list of source files with their exported symbols, group them into logical documentation modules.

Rules:
- Each module should represent a cohesive feature, layer, or domain
- Every file must appear in exactly one module
- Module names should be human-readable (e.g. "Authentication", "Database Layer", "API Routes")
- Aim for 5-15 modules for a typical project. Fewer for small projects, more for large ones
- Group by functionality, not by file type or directory structure alone
- Do NOT create modules for tests, configs, or non-source files`;

export const GROUPING_USER_PROMPT = `Group these source files into documentation modules.

**Files and their exports:**
{{FILE_LIST}}

**Directory structure:**
{{DIRECTORY_TREE}}

Respond with ONLY a JSON object mapping module names to file path arrays. No markdown, no explanation.
Example format:
{
  "Authentication": ["src/auth/login.ts", "src/auth/session.ts"],
  "Database": ["src/db/connection.ts", "src/db/models.ts"]
}`;

// ─── Leaf Module Prompt ───────────────────────────────────────────────

export const MODULE_SYSTEM_PROMPT = `You are a technical documentation writer. Write clear, developer-focused documentation for a code module.

Rules:
- Reference actual function names, class names, and code patterns — do NOT invent APIs
- Use the call graph and execution flow data for accuracy, but do NOT mechanically list every edge
- Include Mermaid diagrams only when they genuinely help understanding. Keep them small (5-10 nodes max)
- Structure the document however makes sense for this module — there is no mandatory format
- Write for a developer who needs to understand and contribute to this code`;

export const MODULE_USER_PROMPT = `Write documentation for the **{{MODULE_NAME}}** module.

## Source Code

{{SOURCE_CODE}}

## Call Graph & Execution Flows (reference for accuracy)

Internal calls: {{INTRA_CALLS}}
Outgoing calls: {{OUTGOING_CALLS}}
Incoming calls: {{INCOMING_CALLS}}
Execution flows: {{PROCESSES}}

---

Write comprehensive documentation for this module. Cover its purpose, how it works, its key components, and how it connects to the rest of the codebase. Use whatever structure best fits this module — you decide the sections and headings. Include a Mermaid diagram only if it genuinely clarifies the architecture.`;

// ─── Parent Module Prompt ─────────────────────────────────────────────

export const PARENT_SYSTEM_PROMPT = `You are a technical documentation writer. Write a summary page for a module that contains sub-modules. Synthesize the children's documentation — do not re-read source code.

Rules:
- Reference actual components from the child modules
- Focus on how the sub-modules work together, not repeating their individual docs
- Keep it concise — the reader can click through to child pages for detail
- Include a Mermaid diagram only if it genuinely clarifies how the sub-modules relate`;

export const PARENT_USER_PROMPT = `Write documentation for the **{{MODULE_NAME}}** module, which contains these sub-modules:

{{CHILDREN_DOCS}}

Cross-module calls: {{CROSS_MODULE_CALLS}}
Shared execution flows: {{CROSS_PROCESSES}}

---

Write a concise overview of this module group. Explain its purpose, how the sub-modules fit together, and the key workflows that span them. Link to sub-module pages (e.g. \`[Sub-module Name](sub-module-slug.md)\`) rather than repeating their content. Use whatever structure fits best.`;

// ─── Overview Prompt ──────────────────────────────────────────────────

export const OVERVIEW_SYSTEM_PROMPT = `You are a technical documentation writer. Write the top-level overview page for a repository wiki. This is the first page a new developer sees.

Rules:
- Be clear and welcoming — this is the entry point to the entire codebase
- Reference actual module names so readers can navigate to their docs
- Include a high-level Mermaid architecture diagram showing only the most important modules and their relationships (max 10 nodes). A new dev should grasp it in 10 seconds
- Do NOT create module index tables or list every module with descriptions — just link to module pages naturally within the text
- Use the inter-module edges and execution flow data for accuracy, but do NOT dump them raw`;

export const OVERVIEW_USER_PROMPT = `Write the overview page for this repository's wiki.

## Project Info

{{PROJECT_INFO}}

## Module Summaries

{{MODULE_SUMMARIES}}

## Reference Data (for accuracy — do not reproduce verbatim)

Inter-module call edges: {{MODULE_EDGES}}
Key system flows: {{TOP_PROCESSES}}

---

Write a clear overview of this project: what it does, how it's architected, and the key end-to-end flows. Include a simple Mermaid architecture diagram (max 10 nodes, big-picture only). Link to module pages (e.g. \`[Module Name](module-slug.md)\`) naturally in the text rather than listing them in a table. If project config was provided, include brief setup instructions. Structure the page however reads best.`;

// ─── Template Substitution Helper ─────────────────────────────────────

/**
 * Replace {{PLACEHOLDER}} tokens in a template string.
 */
export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ─── Formatting Helpers ───────────────────────────────────────────────

/**
 * Format file list with exports for the grouping prompt.
 */
export function formatFileListForGrouping(
  files: Array<{ filePath: string; symbols: Array<{ name: string; type: string }> }>,
): string {
  return files
    .map(f => {
      const exports = f.symbols.length > 0
        ? f.symbols.map(s => `${s.name} (${s.type})`).join(', ')
        : 'no exports';
      return `- ${f.filePath}: ${exports}`;
    })
    .join('\n');
}

/**
 * Build a directory tree string from file paths.
 */
export function formatDirectoryTree(filePaths: string[]): string {
  const dirs = new Set<string>();
  for (const fp of filePaths) {
    const parts = fp.replace(/\\/g, '/').split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }

  const sorted = Array.from(dirs).sort();
  if (sorted.length === 0) return '(flat structure)';

  return sorted.slice(0, 50).join('\n') + (sorted.length > 50 ? `\n... and ${sorted.length - 50} more directories` : '');
}

/**
 * Format call edges as readable text.
 */
export function formatCallEdges(
  edges: Array<{ fromFile: string; fromName: string; toFile: string; toName: string }>,
): string {
  if (edges.length === 0) return 'None';
  return edges
    .slice(0, 30)
    .map(e => `${e.fromName} (${shortPath(e.fromFile)}) → ${e.toName} (${shortPath(e.toFile)})`)
    .join('\n');
}

/**
 * Format process traces as readable text.
 */
export function formatProcesses(
  processes: Array<{
    label: string;
    type: string;
    steps: Array<{ step: number; name: string; filePath: string }>;
  }>,
): string {
  if (processes.length === 0) return 'No execution flows detected for this module.';

  return processes
    .map(p => {
      const stepsText = p.steps
        .map(s => `  ${s.step}. ${s.name} (${shortPath(s.filePath)})`)
        .join('\n');
      return `**${p.label}** (${p.type}):\n${stepsText}`;
    })
    .join('\n\n');
}

/**
 * Shorten a file path for readability.
 */
function shortPath(fp: string): string {
  const parts = fp.replace(/\\/g, '/').split('/');
  return parts.length > 3 ? parts.slice(-3).join('/') : fp;
}

// ─── Unreal / Blueprint Formatting ───────────────────────────────────

import type { BlueprintAssetInfo, BlueprintEdgeData } from './graph-queries.js';

/**
 * Additional context appended to the grouping system prompt for UE projects.
 */
export const GROUPING_UNREAL_ADDENDUM = `
- This is an Unreal Engine project with both C++ source files and Blueprint assets
- Blueprint entries appear as asset paths (e.g. /Game/Characters/BP_Hero)
- Group Blueprints alongside the C++ classes they extend or relate to
- Treat Blueprint asset types (AnimBlueprint, WidgetBlueprint, GameplayAbility) as functional indicators`;

/**
 * Additional context appended to the module system prompt for UE modules with Blueprints.
 */
export const MODULE_UNREAL_ADDENDUM = `
- This module contains Unreal Engine Blueprint assets alongside C++ code. Blueprints are documented as structured summaries (not source code). Document the Blueprint layer — what each Blueprint adds, how it connects to C++, and the cross-language execution flows
- Blueprint inheritance (EXTENDS), interface implementations (IMPLEMENTS), and event overrides (OVERRIDES) are the key cross-language coupling points`;

/**
 * Additional context appended to the overview system prompt for UE projects.
 */
export const OVERVIEW_UNREAL_ADDENDUM = `
- This is an Unreal Engine project with both C++ and Blueprint assets. Include the Blueprint architecture in the overview — asset types, key inheritance hierarchies, and how C++ and Blueprint layers interact
- Gameplay Tags, if present, are UE5's universal semantic namespace for cross-system communication`;

/**
 * Format Blueprint asset summaries for inclusion in module page prompts.
 */
export function formatBlueprintSummaries(
  assets: BlueprintAssetInfo[],
  edgeData: Map<string, BlueprintEdgeData>,
): string {
  if (assets.length === 0) return 'No Blueprint assets in this module.';

  return assets.map(asset => {
    const edges = edgeData.get(asset.assetPath);
    const lines: string[] = [];

    const parentInfo = edges?.extends.length ? `, extends ${edges.extends.join(', ')}` : '';
    lines.push(`### ${asset.name} (${asset.label}${parentInfo})`);

    if (edges) {
      if (edges.implements.length > 0) lines.push(`- Implements: ${edges.implements.join(', ')}`);
      if (edges.calls.length > 0) lines.push(`- Calls: ${edges.calls.slice(0, 15).join(', ')}${edges.calls.length > 15 ? ` (+${edges.calls.length - 15} more)` : ''}`);
      if (edges.imports.length > 0) lines.push(`- Imports: ${edges.imports.slice(0, 10).join(', ')}${edges.imports.length > 10 ? ` (+${edges.imports.length - 10} more)` : ''}`);
      if (edges.overrides.length > 0) lines.push(`- Overrides: ${edges.overrides.join(', ')}`);
      if (edges.dispatches.length > 0) lines.push(`- Event Dispatchers: ${edges.dispatches.join(', ')}`);
      if (edges.gameplayTags.length > 0) lines.push(`- Gameplay Tags: ${edges.gameplayTags.slice(0, 10).join(', ')}${edges.gameplayTags.length > 10 ? ` (+${edges.gameplayTags.length - 10} more)` : ''}`);
    }

    return lines.join('\n');
  }).join('\n\n');
}

/**
 * Format Blueprint asset distribution for the overview page.
 */
export function formatAssetDistribution(dist: Record<string, number>): string {
  const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '';
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return `Total: ${total} Blueprint assets\n` +
    entries.map(([label, count]) => `- ${label}: ${count}`).join('\n');
}

/**
 * Format gameplay tag summary for the overview page.
 */
export function formatGameplayTags(tags: Array<{ tag: string; refCount: number }>): string {
  if (tags.length === 0) return 'No gameplay tags indexed.';
  return tags.map(t => `- ${t.tag} (${t.refCount} refs)`).join('\n');
}
