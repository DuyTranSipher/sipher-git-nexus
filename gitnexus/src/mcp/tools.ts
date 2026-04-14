/**
 * MCP Tool Definitions
 * 
 * Defines the tools that GitNexus exposes to external AI agents.
 * All tools support an optional `repo` parameter for multi-repo setups.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      default?: any;
      items?: { type: string };
      enum?: string[];
    }>;
    required: string[];
  };
}

export const GITNEXUS_TOOLS: ToolDefinition[] = [
  {
    name: 'list_repos',
    description: `List all indexed repositories available to GitNexus.

Returns each repo's name, path, indexed date, last commit, and stats.

WHEN TO USE: First step when multiple repos are indexed, or to discover available repos.
AFTER THIS: READ gitnexus://repo/{name}/context for the repo you want to work with.

When multiple repos are indexed, you MUST specify the "repo" parameter
on other tools (query, context, impact, etc.) to target the correct one.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'sync_unreal_asset_manifest',
    description: `Refresh the Unreal Blueprint asset manifest for a repository.

Uses the configured Unreal Editor commandlet to enumerate Blueprint assets and
store a manifest under .gitnexus/unreal/asset-manifest.json.

Two modes:
- metadata (default): Uses AssetRegistry only — zero Blueprint loading, fast and safe for large projects.
- deep: Loads each Blueprint fully to extract native_function_refs and graph data. Uses batch GC. Pass deep=true.

WHEN TO USE: Before Blueprint-reference queries, after large Blueprint changes, or
to validate Unreal analyzer configuration.
AFTER THIS: Use find_native_blueprint_references() or find_blueprints_derived_from_native_class().`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
        deep: { type: 'boolean', description: 'Deep mode: fully load Blueprints for native_function_refs (slower, higher memory). Default: false (metadata-only).' },
      },
      required: [],
    },
  },
  {
    name: 'find_native_blueprint_references',
    description: `Find direct Blueprint graph references to a native C++ function using the Unreal analyzer.

This is a hybrid query: GitNexus uses the local Blueprint asset manifest to shortlist
candidates, then invokes the Unreal Editor-side analyzer to confirm exact graph nodes.

WHEN TO USE: You have a C++ UFUNCTION or native method and need the Blueprint call sites.
AFTER THIS: Use expand_blueprint_chain() on a returned chain_anchor_id to walk the Blueprint flow.`,
    inputSchema: {
      type: 'object',
      properties: {
        function: { type: 'string', description: 'Native function name or qualified name (for example "ULyraWeaponSpawner::GetPickupInstigator").' },
        symbol_uid: { type: 'string', description: 'Direct symbol UID from prior GitNexus results.' },
        class_name: { type: 'string', description: 'Owning native class name to disambiguate overloaded or same-name functions.' },
        file_path: { type: 'string', description: 'Source file path to disambiguate the target function.' },
        refresh_manifest: { type: 'boolean', description: 'Refresh the Unreal asset manifest before searching.', default: false },
        max_candidates: { type: 'number', description: 'Cap the manifest-derived Blueprint candidates passed to the Unreal analyzer.', default: 200 },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'expand_blueprint_chain',
    description: `Expand a Blueprint execution/call chain from a previously confirmed reference node.

Uses the Unreal analyzer to walk graph links upstream or downstream starting from
a chain anchor returned by find_native_blueprint_references().

WHEN TO USE: After finding a direct Blueprint call node and you need local Blueprint flow context.
AFTER THIS: Inspect returned nodes or continue expansion from another anchor.`,
    inputSchema: {
      type: 'object',
      properties: {
        asset_path: { type: 'string', description: 'Blueprint asset path containing the anchor node.' },
        chain_anchor_id: { type: 'string', description: 'Anchor identifier returned from find_native_blueprint_references().' },
        direction: { type: 'string', description: 'Chain traversal direction.', enum: ['upstream', 'downstream'], default: 'downstream' },
        max_depth: { type: 'number', description: 'Maximum Blueprint traversal depth.', default: 5 },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['asset_path', 'chain_anchor_id'],
    },
  },
  {
    name: 'find_blueprints_derived_from_native_class',
    description: `List Blueprint assets derived from a native C++ class using the Unreal asset manifest.

WHEN TO USE: To discover candidate Blueprint assets for a native class before deeper graph analysis,
or to validate manifest coverage for a gameplay type.
AFTER THIS: Use find_native_blueprint_references() for function-level graph references.`,
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string', description: 'Native class name to search for in Blueprint ancestry.' },
        refresh_manifest: { type: 'boolean', description: 'Refresh the Unreal asset manifest before searching.', default: false },
        max_results: { type: 'number', description: 'Maximum Blueprint assets to return.', default: 200 },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['class_name'],
    },
  },
  {
    name: 'find_blueprints',
    description: `Search Blueprint assets with rich filtering by parent class, component, interface, variable, or gameplay tag.
Queries the asset manifest for matching Blueprints. Works with both metadata and deep mode manifests.

WHEN TO USE: To discover Blueprints matching specific criteria — e.g., "all Blueprints with CameraComponent",
"all Blueprints implementing IInteractable", "all Blueprints with replicated variables".
AFTER THIS: Use context() on a result for full relationship view, or find_native_blueprint_references() for call-site detail.`,
    inputSchema: {
      type: 'object',
      properties: {
        parent_class: { type: 'string', description: 'Filter by native parent class name (e.g., "ACharacter"). Case-insensitive.' },
        component_class: { type: 'string', description: 'Filter by SCS component class (e.g., "CameraComponent"). Requires deep mode manifest.' },
        interface: { type: 'string', description: 'Filter by implemented interface (e.g., "IInteractable"). Requires deep mode manifest.' },
        has_variable: { type: 'string', description: 'Filter by variable name (e.g., "Health"). Requires deep mode manifest.' },
        has_replicated_variable: { type: 'boolean', description: 'Filter to Blueprints with any replicated variable. Requires deep mode manifest.' },
        gameplay_tag: { type: 'string', description: 'Filter by referenced gameplay tag prefix (e.g., "Ability.Attack"). Requires deep mode manifest.' },
        asset_type: { type: 'string', description: 'Filter by asset type label (e.g., "AnimBlueprint", "WidgetBlueprint", "GameplayAbility").' },
        name_pattern: { type: 'string', description: 'Filter by asset name substring (case-insensitive).' },
        max_results: { type: 'number', description: 'Maximum results to return.', default: 100 },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'query',
    description: `Query the code knowledge graph for execution flows related to a concept.
Returns processes (call chains) ranked by relevance, each with its symbols and file locations.

WHEN TO USE: Understanding how code works together. Use this when you need execution flows and relationships, not just file matches. Complements grep/IDE search.
AFTER THIS: Use context() on a specific symbol for 360-degree view (callers, callees, categorized refs).

Returns results grouped by process (execution flow):
- processes: ranked execution flows with relevance priority
- process_symbols: all symbols in those flows with file locations and module (functional area)
- definitions: standalone types/interfaces not in any process

Hybrid ranking: BM25 keyword + semantic vector search, ranked by Reciprocal Rank Fusion.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query' },
        task_context: { type: 'string', description: 'What you are working on (e.g., "adding OAuth support"). Helps ranking.' },
        goal: { type: 'string', description: 'What you want to find (e.g., "existing auth validation logic"). Helps ranking.' },
        limit: { type: 'number', description: 'Max processes to return (default: 5)', default: 5 },
        max_symbols: { type: 'number', description: 'Max symbols per process (default: 10)', default: 10 },
        include_content: { type: 'boolean', description: 'Include full symbol source code (default: false)', default: false },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cypher',
    description: `Execute Cypher query against the code knowledge graph.

WHEN TO USE: Complex structural queries that search/explore can't answer. READ gitnexus://repo/{name}/schema first for the full schema.
AFTER THIS: Use context() on result symbols for deeper context.

SCHEMA:
- Nodes: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process
- Multi-language nodes (use backticks): \`Struct\`, \`Enum\`, \`Trait\`, \`Impl\`, etc.
- All edges via single CodeRelation table with 'type' property
- Edge types: CONTAINS, DEFINES, CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, ACCESSES, OVERRIDES, MEMBER_OF, STEP_IN_PROCESS
- Edge properties: type (STRING), confidence (DOUBLE), reason (STRING), step (INT32)

EXAMPLES:
• Find callers of a function:
  MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: "validateUser"}) RETURN a.name, a.filePath

• Find community members:
  MATCH (f)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community) WHERE c.heuristicLabel = "Auth" RETURN f.name

• Trace a process:
  MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE p.heuristicLabel = "UserLogin" RETURN s.name, r.step ORDER BY r.step

• Find all methods of a class:
  MATCH (c:Class {name: "UserService"})-[r:CodeRelation {type: 'HAS_METHOD'}]->(m:Method) RETURN m.name, m.parameterCount, m.returnType

• Find all properties of a class:
  MATCH (c:Class {name: "User"})-[r:CodeRelation {type: 'HAS_PROPERTY'}]->(p:Property) RETURN p.name, p.description

• Find all writers of a field:
  MATCH (f:Function)-[r:CodeRelation {type: 'ACCESSES', reason: 'write'}]->(p:Property) WHERE p.name = "address" RETURN f.name, f.filePath

• Find method overrides (MRO resolution):
  MATCH (winner:Method)-[r:CodeRelation {type: 'OVERRIDES'}]->(loser:Method) RETURN winner.name, winner.filePath, loser.filePath, r.reason

• Detect diamond inheritance:
  MATCH (d:Class)-[:CodeRelation {type: 'EXTENDS'}]->(b1), (d)-[:CodeRelation {type: 'EXTENDS'}]->(b2), (b1)-[:CodeRelation {type: 'EXTENDS'}]->(a), (b2)-[:CodeRelation {type: 'EXTENDS'}]->(a) WHERE b1 <> b2 RETURN d.name, b1.name, b2.name, a.name

OUTPUT: Returns { markdown, row_count } — results formatted as a Markdown table for easy reading.

TIPS:
- All relationships use single CodeRelation table — filter with {type: 'CALLS'} etc.
- Community = auto-detected functional area (Leiden algorithm)
- Process = execution flow trace from entry point to terminal
- Use heuristicLabel (not label) for human-readable community/process names`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cypher query to execute' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'context',
    description: `360-degree view of a single code symbol.
Shows categorized incoming/outgoing references (calls, imports, extends, implements, methods, properties, overrides), process participation, and file location.

WHEN TO USE: After query() to understand a specific symbol in depth. When you need to know all callers, callees, and what execution flows a symbol participates in.
AFTER THIS: Use impact() if planning changes, or READ gitnexus://repo/{name}/process/{processName} for full execution trace.

Handles disambiguation: if multiple symbols share the same name, returns candidates for you to pick from. Use uid param for zero-ambiguity lookup from prior results.

NOTE: ACCESSES edges (field read/write tracking) are included in context results. Coverage: reads detected during call chain resolution (e.g., user.address.save() emits a read on 'address'). Standalone reads and writes require Phase 2.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (e.g., "validateUser", "AuthService")' },
        uid: { type: 'string', description: 'Direct symbol UID from prior tool results (zero-ambiguity lookup)' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        include_content: { type: 'boolean', description: 'Include full symbol source code (default: false)', default: false },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'detect_changes',
    description: `Analyze uncommitted git changes and find affected execution flows.
Maps git diff hunks to indexed symbols, then traces which processes are impacted.

WHEN TO USE: Before committing — to understand what your changes affect. Pre-commit review, PR preparation.
AFTER THIS: Review affected processes. Use context() on high-risk symbols. READ gitnexus://repo/{name}/process/{name} for full traces.

Returns: changed symbols, affected processes, and a risk summary.`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'What to analyze: "unstaged" (default), "staged", "all", or "compare"', enum: ['unstaged', 'staged', 'all', 'compare'], default: 'unstaged' },
        base_ref: { type: 'string', description: 'Branch/commit for "compare" scope (e.g., "main")' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
  {
    name: 'rename',
    description: `Multi-file coordinated rename using the knowledge graph + text search.
Finds all references via graph (high confidence) and regex text search (lower confidence). Preview by default.

WHEN TO USE: Renaming a function, class, method, or variable across the codebase. Safer than find-and-replace.
AFTER THIS: Run detect_changes() to verify no unexpected side effects.

Each edit is tagged with confidence:
- "graph": found via knowledge graph relationships (high confidence, safe to accept)
- "text_search": found via regex text search (lower confidence, review carefully)`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name to rename' },
        symbol_uid: { type: 'string', description: 'Direct symbol UID from prior tool results (zero-ambiguity)' },
        new_name: { type: 'string', description: 'The new name for the symbol' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        dry_run: { type: 'boolean', description: 'Preview edits without modifying files (default: true)', default: true },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'impact',
    description: `Analyze the blast radius of changing a code symbol.
Returns affected symbols grouped by depth, plus risk assessment, affected execution flows, and affected modules.

WHEN TO USE: Before making code changes — especially refactoring, renaming, or modifying shared code. Shows what would break.
AFTER THIS: Review d=1 items (WILL BREAK). Use context() on high-risk symbols.

Output includes:
- risk: LOW / MEDIUM / HIGH / CRITICAL
- summary: direct callers, processes affected, modules affected
- affected_processes: which execution flows break and at which step
- affected_modules: which functional areas are hit (direct vs indirect)
- byDepth: all affected symbols grouped by traversal depth

Depth groups:
- d=1: WILL BREAK (direct callers/importers)
- d=2: LIKELY AFFECTED (indirect)
- d=3: MAY NEED TESTING (transitive)

TIP: Default traversal uses CALLS/IMPORTS/EXTENDS/IMPLEMENTS. For class members, include HAS_METHOD and HAS_PROPERTY in relationTypes. For field access analysis, include ACCESSES in relationTypes.

EdgeType: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, OVERRIDES, ACCESSES
Confidence: 1.0 = certain, <0.8 = fuzzy match`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of function, class, or file to analyze' },
        direction: { type: 'string', description: 'upstream (what depends on this) or downstream (what this depends on)' },
        maxDepth: { type: 'number', description: 'Max relationship depth (default: 3)', default: 3 },
        relationTypes: { type: 'array', items: { type: 'string' }, description: 'Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, OVERRIDES, ACCESSES (default: usage-based, ACCESSES excluded by default)' },
        includeTests: { type: 'boolean', description: 'Include test files (default: false)' },
        minConfidence: { type: 'number', description: 'Minimum confidence 0-1 (default: 0.7)' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: ['target', 'direction'],
    },
  },
];
