# Changelog

All notable changes to GitNexus will be documented in this file.

## [Unreleased]

## [1.3.6] - 2026-03-31

### Fixed

- **Unreal glob `**` segment boundary**: `/**/ST_*` no longer false-matches assets whose names contain `ST_` as a substring (e.g. `GCN_Burst_*`). The `**` wildcard now only tries the remaining pattern at path-segment boundaries (positions after `/`), matching standard glob semantics.
- **StateTree assets indexed**: `gitnexus unreal-sync` now discovers `UStateTree` assets in addition to Blueprints. `UStateTree` derives from `UDataAsset` (not `UBlueprint`), so it was previously invisible to the asset registry query — fixed by adding `/Script/StateTreeModule.StateTree` to the `FARFilter` class paths.

### Added

- **Glob and regex pattern support for Unreal path filters**: `include_paths` and `exclude_paths` in Unreal config now accept glob patterns (`/**/ST_*`, `Content/**`) and regex patterns (`regex:/Game/ST_`). Values containing `*`, `?`, or `[`, or starting with `regex:`, are automatically routed to the C++ pattern-matching path; plain strings continue to use the fast prefix check.

### Added
- `gitnexus sipher-patched [path]` S2 preflight command for validating Sipher gateway environment before wiki generation
- Sipher gateway header support for wiki LLM requests via `AI_GATEWAY_API_KEY`, `AI_GATEWAY_CREDENTIAL`, and `AI_GATEWAY_GROUP`

### Changed
- Wiki generation now uses code-centric inputs for large repositories instead of grouping repo-wide docs and metadata into one giant prompt
- Large repositories switch to deterministic module grouping when the initial grouping prompt would be too large
- Wiki prompt sections now enforce bounded token budgets before calling the LLM

### Fixed
- Retry wiki LLM requests without streaming when the gateway returns `empty_stream: upstream stream closed before first payload`
- Exclude `.uasset` and `.umap` files from wiki prompt construction and token estimation
- Prevent S2 wiki generation from failing on the initial module-grouping call due to oversized prompt payloads

## [1.3.3] - 2026-03-27

### Fixed

- **Unreal setup --force preserves config**: Re-running `gitnexus setup --unreal --force` now merges defaults under existing config values instead of overwriting user customizations (include_paths, exclude_paths, etc.)

## [1.3.2] - 2026-03-27

### Added

- **Shared Unreal configuration**: New `.gitnexus-unreal.json` at project root for team-shared settings (committable to git), while machine-specific settings (editor_cmd, project_path) stay in `.gitnexus/unreal/config.json` (gitignored)

## [1.3.1] - 2026-03-27

### Fixed

- **Auto-convert filesystem paths to Unreal package paths**: `include_paths` and `exclude_paths` in Unreal config now accept Windows filesystem paths (e.g., `Content/Characters/`) and automatically convert them to Unreal virtual paths (`/Game/Characters/`)

## [1.3.0] - 2026-03-27

### Added

- **Metadata-only Unreal sync mode**: Default sync now scans Blueprint asset metadata (parent class, dependencies) without loading full assets — fast and crash-resilient
- **`--deep` flag for full sync**: `gitnexus unreal-sync --deep` loads Blueprint assets fully for pin-level and node-level data (original behavior)
- **`include_paths` filtering**: Restrict Unreal sync to specific content directories via config, reducing scan scope on large projects
- **`.gitnexusignore` support for Unreal sync**: Ignore patterns are converted to Unreal package prefixes and passed to the C++ commandlet for asset filtering

## [1.2.2] - 2026-03-26

### Added

- **Spinner UX for Unreal sync**: Progress spinner during commandlet execution with elapsed time
- **CWD repo resolution**: `gitnexus unreal-sync` now auto-detects the repository when run from within a project directory
- **Resilient error handling**: Improved error messages with UE log tailing on commandlet failures

### Fixed

- **Engine auto-detection fallback**: Added `LauncherInstalled.dat` lookup for Epic Games Launcher engine installations, fixing auto-detection on machines where the registry key is absent

## [1.2.0] - 2026-03-26

### Added

- **Unreal Blueprint graph indexing**: Blueprint assets are now first-class nodes in the LadybugDB knowledge graph, with EXTENDS, CALLS, and IMPORTS edges linking Blueprints to C++ parents and dependencies
- **Blueprint chain expansion enrichment**: Pin-level data (exec/data split, connections, defaults), node metadata, type-specific details, and BFS traversal context are now included when expanding Blueprint chains
- **Native Anthropic API support** for wiki generation: auto-detects Anthropic API URLs and routes directly to the Messages API instead of requiring an OpenAI-compatible proxy
- **Failed module retry** for wiki generation: persists failed module names to metadata and retries only those on re-run, avoiding redundant LLM calls

### Fixed

- **LadybugDB Cypher compatibility**: replaced `labels(n)[0]` (array subscript) with `labels(n)` (returns string) across 16 query sites, fixing query failures on LadybugDB engine
- **C++ out-of-line method resolution**: out-of-line method definitions (e.g., `ClassName::Method`) now correctly produce HAS_METHOD edges, restoring symbol type information in MCP tools

### Changed

- Migrated from KuzuDB to LadybugDB v0.15 (`@ladybugdb/core`, `@ladybugdb/wasm-core`)
- Renamed all internal paths from `kuzu` to `lbug` (storage: `.gitnexus/kuzu` → `.gitnexus/lbug`)
- Added automatic cleanup of stale KuzuDB index files
- LadybugDB v0.15 requires explicit VECTOR extension loading for semantic search

## [1.4.6] - 2026-03-18

### Added
- **Phase 7 type resolution** — return-aware loop inference for call-expression iterables (#341)
  - `ReturnTypeLookup` interface with `lookupReturnType` / `lookupRawReturnType` split
  - `ForLoopExtractorContext` context object replacing positional `(node, env)` signature
  - Call-expression iterable resolution across 8 languages (TS/JS, Java, Kotlin, C#, Go, Rust, Python, PHP)
  - PHP `$this->property` foreach via `@var` class property scan (Strategy C)
  - PHP `function_call_expression` and `member_call_expression` foreach paths
  - `extractElementTypeFromString` as canonical raw-string container unwrapper in `shared.ts`
  - `extractReturnTypeName` deduplicated from `call-processor.ts` into `shared.ts` (137 lines removed)
  - `SKIP_SUBTREE_TYPES` performance optimization with documented `template_string` exclusion
  - `pendingCallResults` infrastructure (dormant — Phase 9 work)

### Fixed
- **impact**: return structured error + partial results instead of crashing (#345)
- **impact**: add `HAS_METHOD` and `OVERRIDES` to `VALID_RELATION_TYPES` (#350)
- **cli**: write tool output to stdout via fd 1 instead of stderr (#346)
- **postinstall**: add permission fix for CLI and hook scripts (#348)
- **workflow**: use prefixed temporary branch name for fork PRs to prevent overwriting real branches
- **test**: add `--repo` to CLI e2e tool tests for multi-repo environment
- **php**: add `declaration_list` type guard on `findClassPropertyElementType` fallback
- **docs**: correct `pendingCallResults` description in roadmap and system docs

### Chore
- Add `.worktrees/` to `.gitignore`

## [1.4.5] - 2026-03-17

### Added
- **Ruby language support** for CLI and web (#111)
- **TypeEnvironment API** with constructor inference, self/this/super resolution (#274)
- **Return type inference** with doc-comment parsing (JSDoc, PHPDoc, YARD) and per-language type extractors (#284)
- **Phase 4 type resolution** — nullable unwrapping, for-loop typing, assignment chain propagation (#310)
- **Phase 5 type resolution** — chained calls, pattern matching, class-as-receiver (#315)
- **Phase 6 type resolution** — for-loop Tier 1c, pattern matching, container descriptors, 10-language coverage (#318)
  - Container descriptor table for generic type argument resolution (Map keys vs values)
  - Method-aware for-loop extractors with integration tests for all languages
  - Recursive pattern binding (C# `is` patterns, Kotlin `when/is` smart casts)
  - Class field declaration unwrapping for C#/Java
  - PHP `$this->property` foreach member access
  - C++ pointer dereference range-for
  - Java `this.data.values()` field access patterns
  - Position-indexed when/is bindings for branch-local narrowing
- **Type resolution system documentation** with architecture guide and roadmap
- `.gitignore` and `.gitnexusignore` support during file discovery (#231)
- Codex MCP configuration documentation in README (#236)
- `skipGraphPhases` pipeline option to skip MRO/community/process phases for faster test runs
- `hookTimeout: 120000` in vitest config for CI beforeAll hooks

### Changed
- **Migrated from KuzuDB to LadybugDB v0.15** (#275)
- Dynamically discover and install agent skills in CLI (#270)

### Performance
- Worker pool threshold — skip worker creation for small repos (<15 files or <512KB total)
- AST walk pruning via `SKIP_SUBTREE_TYPES` for leaf-only nodes (string, comment, number literals)
- Pre-computed `interestingNodeTypes` set — single Set.has() replaces 3 checks per AST node
- `fastStripNullable` — skip full nullable parsing for simple identifiers (90%+ case)
- Replace `.children?.find()` with manual for loops in `extractFunctionName` to eliminate array allocations

### Fixed
- Same-directory Python import resolution (#328)
- Ruby method-level call resolution, HAS_METHOD edges, and dispatch table (#278)
- C++ fixture file casing for case-sensitive CI
- Template string incorrectly included in AST pruning set (contains interpolated expressions)

## [1.4.0] - Previous release
