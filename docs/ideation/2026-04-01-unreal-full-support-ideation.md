---
date: 2026-04-01
topic: unreal-full-support
focus: Fully support Unreal Engine projects — Blueprint analysis, C++ integration, Unreal-specific asset types, game dev workflows
---

# Ideation: Full Unreal Engine Support for GitNexus

## Codebase Context

**Project shape:** GitNexus is an ESM-only TypeScript CLI + MCP server that builds code knowledge graphs for AI agents. It uses tree-sitter for 13-language AST parsing, LadybugDB for graph storage, and Graphology for in-memory graph operations. A C++ Unreal Engine plugin (commandlet) extracts Blueprint data, and a React/Vite web UI provides visualization.

**Current Unreal support (thin):**
- C++ commandlet (`GitNexusBlueprintAnalyzerCommandlet`) extracts Blueprint data from `.uasset` files via 3 operations: SyncAssets, FindNativeBlueprintReferences, ExpandBlueprintChain
- TypeScript bridge (`bridge.ts`) spawns `UnrealEditor-Cmd.exe`, parses JSON output
- Blueprint ingestion (`blueprint-ingestion.ts`) creates graph nodes and EXTENDS/CALLS/IMPORTS edges
- Only 4 TS files for Unreal (`bridge.ts`, `types.ts`, `config.ts`, `blueprint-ingestion.ts`)
- No coverage for: AnimBPs, WidgetBPs, DataTables, GameplayAbilities, StateTree beyond basic discovery
- No C++ UCLASS/UFUNCTION/UPROPERTY reflection metadata linking to Blueprints
- No dedicated `gitnexus unreal` CLI command — piggybacks on generic analyze

**Key embedded learnings from past work:**
- BP-to-BP inheritance was initially missed — always handle BP<->BP, not just BP->C++ (commit c0dddc7)
- Indexing assets isn't enough — search/query layer must also be updated (commit c764491)
- C++ commandlet and TS bridge JSON contract has historically drifted (commit 33c32be)
- Full asset loading crashes on large projects — metadata-only mode is default (commit 7913082)
- Filesystem paths vs Unreal package paths cause confusion (commit ea2a994)
- LadybugDB Cypher is a subset of Neo4j — test queries against actual engine (commit 97a743b)

## Ranked Ideas

### 1. First-Class Asset Type Taxonomy

**Description:** Replace the single `'Blueprint'` NodeLabel with discriminated types: `AnimBlueprint`, `WidgetBlueprint`, `GameplayAbility`, `StateTree`, `DataTable`, `DataAsset`. The commandlet already has access to `FAssetData.AssetClassPath` at metadata-scan time — zero additional loading required. One schema change to `types.ts` propagates through search, impact, and all MCP tools automatically.

**Implementation Plan:**
1. Extend `NodeLabel` in `core/graph/types.ts` with new asset type labels
2. Add `asset_class?: string` field to `UnrealAssetManifestAsset` in `unreal/types.ts`
3. Emit `asset_class` from commandlet's `RunSyncAssetsMetadata` and `RunSyncAssetsDeep` using `AssetData.AssetClassPath.ToString()` — zero loading cost
4. Add `assetClassToLabel()` mapping function in `blueprint-ingestion.ts` to convert asset_class strings to typed NodeLabels
5. Update search layer to index and surface new labels (per lesson from commit c764491)

**Files:** `core/graph/types.ts`, `unreal/types.ts`, `GitNexusBlueprintAnalyzerCommandlet.cpp`, `blueprint-ingestion.ts`, search layer
**Scope:** ~100 LOC

**Rationale:** An AI agent asking "what controls the character's animation?" currently gets a flat pile of Blueprint nodes with no way to distinguish UI widgets from animation state machines from gameplay logic. Typed nodes make queries dramatically more precise and enable Cypher queries like `MATCH (n:AnimBlueprint)`.

**Downsides:** Requires mapping the UE class hierarchy to a manageable set of labels — the long tail of exotic asset types needs a fallback to `'Blueprint'`.

**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

---

### 2. First-Class `gitnexus unreal` CLI Workflow

**Description:** Add a `gitnexus unreal` command namespace with subcommands: `init` (validates UE project, writes config), `sync` (runs commandlet + ingests with progress), `status` (manifest freshness, asset counts by type, last sync time). Make `gitnexus analyze` auto-detect `.uproject` files and prompt for `gitnexus unreal init` if unconfigured.

**Implementation Plan:**
1. Create `gitnexus unreal` parent command in `cli/index.ts` with subcommands: `init`, `sync [--deep]`, `status`
2. Auto-detect `.uproject` files in `gitnexus analyze` (`cli/analyze.ts`) — prompt for `gitnexus unreal init` if unconfigured
3. Implement `unreal status` (new `cli/unreal-status.ts`) — read manifest, print freshness, asset counts by type, plugin version
4. Wire progress into sync via existing `withUnrealProgress` wrapper
5. Preserve existing `unreal-find-refs`, `unreal-expand-chain`, `unreal-derived-blueprints` as subcommands with backward-compatible aliases

**Files:** `cli/index.ts`, `cli/analyze.ts`, new `cli/unreal-status.ts`, `cli/unreal-progress.ts`
**Scope:** ~250 LOC

**Rationale:** There is no single "I want to index this UE project" command today. New users must discover they need a C++ plugin, manual config, an MCP tool call, then `analyze`. Each step fails independently with cryptic errors. A dedicated command makes Unreal support discoverable and transforms it from a power-user feature into something that works on first use.

**Downsides:** Another command surface to maintain. Risk of scope creep into "Unreal project management" territory.

**Confidence:** 90%
**Complexity:** Low-Medium
**Status:** Unexplored

---

### 3. UCLASS/UFUNCTION/UPROPERTY Reflection Extraction via Tree-sitter

**Description:** Extend the existing tree-sitter C++ pass to recognize UE reflection macros (UCLASS, UFUNCTION, UPROPERTY, USTRUCT, UINTERFACE, UENUM) and extract their specifiers (BlueprintCallable, BlueprintImplementableEvent, BlueprintNativeEvent, BlueprintReadWrite, etc.) as first-class node properties. This lets the graph distinguish which C++ symbols are exposed to Blueprints — without running the UE Editor.

**Implementation Plan:**
1. Add UE macro tree-sitter queries to `CPP_QUERIES` in `tree-sitter-queries.ts` — capture macro invocations and their argument text containing specifiers
2. Parse specifiers in the extraction pipeline (`parse-worker.ts`) — associate each macro with the immediately following class/function/variable declaration by walking AST siblings
3. Store specifiers as node properties — add `ueSpecifiers?: string[]` and `ueMeta?: Record<string, string>` to `NodeProperties` in `core/graph/types.ts`
4. Wire into `blueprint-ingestion.ts` — when creating CALLS edges, check target's `ueSpecifiers` for `BlueprintCallable` to set `confidence: 1.0`; flag `BlueprintImplementableEvent` functions as requiring Blueprint override

**Files:** `tree-sitter-queries.ts`, `parse-worker.ts`, `core/graph/types.ts`, `blueprint-ingestion.ts`
**Scope:** ~300 LOC

**Rationale:** This is the single highest-leverage gap. Every C++ function currently looks identical in the graph — impact analysis can't distinguish an internal helper from a BlueprintCallable contract function. Once specifiers are graph properties, `gitnexus_impact` on a BlueprintImplementableEvent can warn that every subclassing Blueprint will break.

**Downsides:** UE macros have complex nesting (meta=(key=value,...)) that requires careful tree-sitter query design. Generated headers (*.generated.h) might confuse the parser.

**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

---

### 4. Cross-Language IMPLEMENTS/OVERRIDES/DISPATCHES Edges

**Description:** Add three missing edge types that model runtime coupling between C++ contracts and Blueprint implementations: OVERRIDES (BP overrides a BlueprintNativeEvent), IMPLEMENTS (BP implements a Blueprint Interface), DISPATCHES/SUBSCRIBES_TO (Event Dispatcher bindings). These are the actual runtime coupling mechanisms in Unreal.

**Implementation Plan:**
1. Extend commandlet deep mode to extract new relationship data:
   - **Interfaces:** Read `Blueprint->ImplementedInterfaces` → emit `"implements_interfaces"` JSON array
   - **Event Dispatchers:** Walk function graphs for `UK2Node_CreateDelegate` / `UK2Node_ComponentBoundEvent` → emit `"event_dispatchers"` array
   - **Overrides:** Walk event graph entry nodes (`UK2Node_Event`) matching parent's BlueprintNativeEvent/BlueprintImplementableEvent → emit `"event_overrides"` array
2. Add new fields to `UnrealAssetManifestAsset` in `unreal/types.ts`
3. Create new edges in `blueprint-ingestion.ts` (fourth pass): IMPLEMENTS, OVERRIDES, DISPATCHES/SUBSCRIBES_TO
4. Add `'DISPATCHES' | 'SUBSCRIBES_TO'` to `RelationshipType` in `core/graph/types.ts` if needed

**Depends on:** Idea #3 (Reflection Extraction) for full OVERRIDES accuracy — knowing which C++ functions are BlueprintNativeEvent

**Files:** `GitNexusBlueprintAnalyzerCommandlet.cpp/.h`, `unreal/types.ts`, `blueprint-ingestion.ts`, `core/graph/types.ts`
**Scope:** ~400 LOC (heaviest on C++ side)

**Rationale:** Event Dispatchers are the most common source of hidden coupling in large UE projects — removing one silently breaks many other Blueprints at runtime. `gitnexus_impact` on an Event Dispatcher currently returns zero upstream references because the binding is invisible to the graph.

**Downsides:** Requires deep-mode asset loading (crash-prone). The UK2Node_CreateDelegate / UK2Node_ComponentBoundEvent API may vary across UE versions.

**Confidence:** 80%
**Complexity:** Medium-High
**Status:** Unexplored

---

### 5. Gameplay Tag Semantic Layer

**Description:** Model Gameplay Tags as first-class graph nodes with a hierarchical PARENT_TAG structure, and link Blueprints/C++ classes to them via REFERENCES_TAG edges. Tags are UE5's universal semantic namespace — abilities, effects, states, and UI all communicate through tag strings like `Ability.Attack.Melee`.

**Implementation Plan:**
1. Parse tag config files (new `unreal/gameplay-tags.ts`) — read `DefaultGameplayTags.ini` and plugin tag tables, build tag tree
2. Add tag extraction to commandlet deep mode — iterate CDO properties looking for `FGameplayTag`/`FGameplayTagContainer`, emit `"gameplay_tags"` per asset
3. Extend types — add `gameplay_tags?: string[]` to `UnrealAssetManifestAsset`, add `'GameplayTag'` to NodeLabel and `'REFERENCES_TAG' | 'PARENT_TAG'` to RelationshipType
4. Ingest tags during blueprint ingestion — create GameplayTag nodes with PARENT_TAG hierarchy, create REFERENCES_TAG edges from Blueprint assets
5. Enable tag-aware search — add GameplayTag to searchable labels

**Files:** New `unreal/gameplay-tags.ts`, `GitNexusBlueprintAnalyzerCommandlet.cpp`, `unreal/types.ts`, `core/graph/types.ts`, `blueprint-ingestion.ts`
**Scope:** ~350 LOC

**Rationale:** In GAS-heavy projects, tag strings are the primary coupling mechanism between systems. A refactored tag name spans C++ structs, Blueprint graphs, DataAssets, and config files simultaneously. No other code intelligence tool models this.

**Downsides:** Reading CDO properties requires fully loading the Blueprint (crash-prone). Tags in DataAssets or plugin configs may be missed in v1. Dynamic tag construction is invisible to static analysis.

**Confidence:** 75%
**Complexity:** Medium-High
**Status:** Unexplored

---

### 6. Blueprint Execution Flow Extraction as GitNexus Processes

**Description:** Walk Blueprint Event Graphs at index time and extract execution chains anchored at event nodes (BeginPlay, Tick, OnHit, custom events) as first-class Process nodes. The commandlet's `ExpandBlueprintChain` BFS traversal already does this on-demand — repurpose it at index time to create persistent process models alongside existing C++ execution flows.

**Implementation Plan:**
1. Add new commandlet operation `ExtractFlows` — for each Blueprint in deep mode, walk each EventGraph, find entry event nodes, BFS along exec pin connections up to depth 15, serialize chains as `{ event_name, asset_path, steps: UnrealChainNode[] }`
2. Extend `UnrealAssetManifestAsset` with `flows?: { event_name: string; steps: UnrealChainNode[] }[]`
3. Create Process nodes and STEP_IN_PROCESS edges in `blueprint-ingestion.ts` — link processes to owning Blueprint via CONTAINS, cross-reference steps calling native C++ functions
4. Verify that existing `gitnexus://repo/{name}/processes` MCP resource and query process-grouping automatically pick up Blueprint processes

**Depends on:** Ideas #1, #2, #3 for full cross-language linking in processes

**Files:** `GitNexusBlueprintAnalyzerCommandlet.cpp/.h`, `unreal/types.ts`, `blueprint-ingestion.ts`
**Scope:** ~500 LOC

**Rationale:** The biggest daily friction for engineers on UE projects is tracing "what actually runs when X happens?" across C++ and Blueprint simultaneously. Today GitNexus answers this for C++ but gives blank for Blueprint logic. Unified processes make `gitnexus_query('damage handling flow')` return the full cross-language execution path.

**Downsides:** Blueprint graphs can be very large and branchy — serializing all execution chains at index time could bloat the manifest. Requires deep-mode loading. Recursive/circular Blueprint call patterns need cycle detection.

**Confidence:** 70%
**Complexity:** High
**Status:** Unexplored

---

## Execution Order

```
Phase 1 — Foundation (parallel, no dependencies)
┌──────────────────────────────────────────────────────┐
│  #1 Asset Type Taxonomy     │  #2 CLI Workflow       │
│  Complexity: Low             │  Complexity: Low-Med   │
│  ~100 LOC                    │  ~250 LOC              │
│  Immediate precision gains   │  Immediate DX gains    │
└──────────────────────────────────────────────────────┘
                        │
Phase 2 — Core (sequential, depends on Phase 1)
┌──────────────────────────────────────────────────────┐
│  #3 Reflection Extraction (Medium, ~300 LOC)         │
│  ↓ enables                                           │
│  #4 Cross-Language Edges (Medium-High, ~400 LOC)     │
└──────────────────────────────────────────────────────┘
                        │
Phase 3 — Differentiators (parallel, depends on Phase 2)
┌──────────────────────────────────────────────────────┐
│  #5 Gameplay Tags           │  #6 Execution Flows    │
│  Complexity: Medium-High     │  Complexity: High      │
│  ~350 LOC                    │  ~500 LOC              │
│  GAS-project game changer    │  "What runs when X?"   │
└──────────────────────────────────────────────────────┘
```

Total estimated scope: ~1,900 LOC across C++ and TypeScript.

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | JSON Contract Versioning | Important but tactical testing concern, not a product capability gap |
| 2 | Parse .uasset Binary Directly | Months of reverse-engineering work for uncertain coverage; premature |
| 3 | Persistent Editor Daemon / Process Pool | High architectural complexity; incremental sync is a simpler path |
| 4 | Push-based Model (Editor pushes to GitNexus) | Inverts too much architecture; requires significant UE plugin work |
| 5 | Generate Virtual C++ Headers for Blueprints | Clever but fragile intermediate representation |
| 6 | Unified Symbol Space (BP IS C++) | Graph already has both; the real gap is edges, not labels |
| 7 | Canonical Path Map Sidecar | Useful but narrow — one friction point |
| 8 | Real-time UE Log Streaming | Nice DX but not a capability gap |
| 9 | Component Hierarchy Graph | Subsumed by typed assets + cross-language edges |
| 10 | Content-Hash Asset Identity | Optimization detail, not top-level improvement |
| 11 | Incremental Hash-Based Sync | Tactical performance optimization |
| 12 | Broken Reference Topology | Niche for large teams |
| 13 | Crash-Resistant Deep Scan | Reliability fix but tactical |
| 14 | AnimGraph State Machine Extractor | Subsumed by typed assets + execution flows |
| 15 | Blueprint Variable Property Nodes | Medium value; less critical than function/event/tag coverage |
| 16 | Ambient Unreal Context Resource | Derivative — falls out naturally from richer graph |
| 17 | Cross-Reference Index (UE/Git paths) | Narrow utility |
| 18 | Blueprint Semantic Diffing | Very high value but very high complexity; Phase 2 after graph model solidifies |
| 19 | Invert Pipeline Direction | Interesting reframe but over-engineered for current maturity |
| 20 | Model Runtime Architecture (Actors/Components/Subsystems) | Too abstract; specific edge types are more actionable |
| 21 | Asset-Registry-Driven Delta Sync | Good optimization but doesn't add new capability |

## Session Log
- 2026-04-01: Initial ideation — 48 candidates generated from 6 parallel ideation agents, 23 unique after dedup, 6 survived adversarial filtering. Implementation plans and execution order defined for all 6 survivors.
