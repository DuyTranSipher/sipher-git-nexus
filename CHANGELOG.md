# Changelog

All notable changes to GitNexus will be documented in this file.

## [1.5.0] - 2026-04-02

### Added

- **Unreal Blueprint wiki support**: Wiki generation auto-detects UE projects and documents Blueprint assets alongside C++ source code
- **Blueprint graph queries for wiki**: Structured relationship data (EXTENDS, CALLS, IMPORTS, IMPLEMENTS, OVERRIDES, DISPATCHES, REFERENCES_TAG) for wiki pages
- **UE-aware LLM prompts**: Grouping, module, and overview prompts include Unreal-specific context when Blueprint content is detected
- **`--exclude` flag for wiki generation**: Persistent directory exclusion patterns saved to `wiki/config.json`
- **`.uproject` metadata in wiki overview**: Engine version, C++ modules, and enabled plugins from the project file

### Fixed

- **Incremental wiki updates detect `.uasset`/`.umap` changes**
- **Excluded files respected in incremental mode**

## [1.4.2] - 2026-04-01

### Fixed

- **Unreal sync spinner**: Smooth bouncing dots animation with stable text rendering
- **Spinner progress wiring**: Wire up spinner progress animation for the sync command lifecycle

## [1.4.0] - 2026-04-01

### Added

- **Gameplay Tag semantic layer**: First-class `GameplayTag` nodes with `REFERENCES_TAG` edges
- **Blueprint execution flow extraction**: Blueprint node graphs produce execution flow entries
- **Cross-language IMPLEMENTS, OVERRIDES, DISPATCHES edges**: Typed edges linking Blueprint and C++ nodes
- **UE reflection macro extraction**: `UCLASS`, `UPROPERTY`, `UFUNCTION`, `USTRUCT`, `UENUM` macros parsed from C++ headers
- **Asset type taxonomy**: Typed asset schemas with label-per-type graph nodes
- **`gitnexus unreal` CLI namespace**: First-class CLI command group for Unreal Engine workflows

## [1.3.12] - 2026-04-01

### Fixed

- **Vendor UE plugin source update**: Updated bundled Unreal Engine plugin source

## [1.3.11] - 2026-03-31

### Added

- **Incremental deep sync**: Mtime-based change detection for `gitnexus unreal-sync --deep`

## [1.3.10] - 2026-03-31

### Fixed

- **Blueprint-to-Blueprint EXTENDS edges**: EXTENDS edges between Blueprint assets that inherit from other Blueprints

## [1.3.8] - 2026-03-31

### Fixed

- **Blueprint/StateTree search discovery**: Assets now discoverable by `gitnexus_query`

## [1.3.7] - 2026-03-31

### Fixed

- **Unreal deep mode drops non-Blueprint assets**: `gitnexus unreal-sync --deep` now includes `UStateTree` assets

## [1.3.6] - 2026-03-31

### Fixed

- **Unreal glob `**` segment boundary**: Fixed false-matching on `**` patterns
- **StateTree assets indexed**: Added `UStateTree` to asset registry query

### Added

- **Glob and regex pattern support for Unreal path filters**

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

## [1.1.0] - 2026-03-24 (Sipher fork baseline)

### Added

- **Unreal Engine plugin integration**: GitNexusUnreal C++ commandlet for Blueprint reference analysis from within Unreal Editor
- **`gitnexus setup --unreal`** command for one-step Unreal plugin installation with auto-detection of `.uproject` and `UnrealEditor-Cmd.exe`
- **Unreal Blueprint reference analysis tools** exposed via MCP for AI agent workflows
- **Bundled Unreal plugin** in npm package (`vendor/` directory) for standalone install without source checkout
- **Agent skills documentation** (`skills/`) for Claude Code and Cursor integration

### Fixed

- **Wiki generation hardening** for large repositories with improved chunking and error resilience
- **UE commandlet error diagnostics**: captures stderr, stdout, and tails UE project log for detailed failure messages
- **Sync output parsing** aligned with actual UE commandlet JSON format, fixing `JSON.stringify(undefined)` errors

---

## [1.4.0] - 2026-03-13

### Added

- **Language-aware symbol resolution engine** with 3-tier resolver: exact FQN → scope-walk → guarded fuzzy fallback that refuses ambiguous matches (#238) — @magyargergo
- **Method Resolution Order (MRO)** with 5 language-specific strategies: C++ leftmost-base, C#/Java class-over-interface, Python C3 linearization, Rust qualified syntax, default BFS (#238) — @magyargergo
- **Constructor & struct literal resolution** across all languages — `new Foo()`, `User{...}`, C# primary constructors, target-typed new (#238) — @magyargergo
- **Receiver-constrained resolution** using per-file TypeEnv — disambiguates `user.save()` vs `repo.save()` via `ownerId` matching (#238) — @magyargergo
- **Heritage & ownership edges** — HAS_METHOD, OVERRIDES, Go struct embedding, Swift extension heritage, method signatures (`parameterCount`, `returnType`) (#238) — @magyargergo
- **Language-specific resolver directory** (`resolvers/`) — extracted JVM, Go, C#, PHP, Rust resolvers from monolithic import-processor (#238) — @magyargergo
- **Type extractor directory** (`type-extractors/`) — per-language type binding extraction with `Record<SupportedLanguages, Handler>` + `satisfies` dispatch (#238) — @magyargergo
- **Export detection dispatch table** — compile-time exhaustive `Record` + `satisfies` pattern replacing switch/if chains (#238) — @magyargergo
- **Language config module** (`language-config.ts`) — centralized tsconfig, go.mod, composer.json, .csproj, Swift package config loaders (#238) — @magyargergo
- **Optional skill generation** via `npx gitnexus analyze --skills` — generates AI agent skills from KuzuDB knowledge graph (#171) — @zander-raycraft
- **First-class C# support** — sibling-based modifier scanning, record/delegate/property/field/event declaration types (#163, #170, #178 via #237) — @Alice523, @benny-yamagata, @jnMetaCode
- **C/C++ support fixes** — `.h` → C++ mapping, static-linkage export detection, qualified/parenthesized declarators, 48 entry point patterns (#163, #227 via #237) — @Alice523, @bitgineer
- **Rust support fixes** — sibling-based `visibility_modifier` scanning for `pub` detection (#227 via #237) — @bitgineer
- **Adaptive tree-sitter buffer sizing** — `Math.min(Math.max(contentLength * 2, 512KB), 32MB)` (#216 via #237) — @JasonOA888
- **Call expression matching** in tree-sitter queries (#234 via #237) — @ex-nihilo-jg
- **DeepSeek model configurations** (#217) — @JasonOA888
- 282+ new unit tests, 178 integration resolver tests across 9 languages, 53 test files, 1146 total tests passing

### Fixed

- Skip unavailable native Swift parsers in sequential ingestion (#188) — @Gujiassh
- Heritage heuristic language-gated — no longer applies class/interface rules to wrong languages (#238) — @magyargergo
- C# `base_list` distinguishes EXTENDS vs IMPLEMENTS via symbol table + `I[A-Z]` heuristic (#238) — @magyargergo
- Go `qualified_type` (`models.User`) correctly unwrapped in TypeEnv (#238) — @magyargergo
- Global tier no longer blocks resolution when kind/arity filtering can narrow to 1 candidate (#238) — @magyargergo

### Changed

- `import-processor.ts` reduced from 1412 → 711 lines (50% reduction) via resolver and config extraction (#238) — @magyargergo
- `type-env.ts` reduced from 635 → ~125 lines via type-extractor extraction (#238) — @magyargergo
- CI/CD workflows hardened with security fixes and fork PR support (#222, #225) — @magyargergo

## [1.3.11] - 2026-03-08

### Security

- Fix FTS Cypher injection by escaping backslashes in search queries (#209) — @magyargergo

### Added

- Auto-reindex hook that runs `gitnexus analyze` after commits and merges, with automatic embeddings preservation (#205) — @L1nusB
- 968 integration tests (up from ~840) covering unhappy paths across search, enrichment, CLI, pipeline, worker pool, and KuzuDB (#209) — @magyargergo
- Coverage auto-ratcheting so thresholds bump automatically on CI (#209) — @magyargergo
- Rich CI PR report with coverage bars, test counts, and threshold tracking (#209) — @magyargergo
- Modular CI workflow architecture with separate unit-test, integration-test, and orchestrator jobs (#209) — @magyargergo

### Fixed

- KuzuDB native addon crashes on Linux/macOS by running integration tests in isolated vitest processes with `--pool=forks` (#209) — @magyargergo
- Worker pool `MODULE_NOT_FOUND` crash when script path is invalid (#209) — @magyargergo

### Changed

- Added macOS to the cross-platform CI test matrix (#208) — @magyargergo

## [1.3.10] - 2026-03-07

### Security

- **MCP transport buffer cap**: Added 10 MB `MAX_BUFFER_SIZE` limit to prevent out-of-memory attacks via oversized `Content-Length` headers or unbounded newline-delimited input
- **Content-Length validation**: Reject `Content-Length` values exceeding the buffer cap before allocating memory
- **Stack overflow prevention**: Replaced recursive `readNewlineMessage` with iterative loop to prevent stack overflow from consecutive empty lines
- **Ambiguous prefix hardening**: Tightened `looksLikeContentLength` to require 14+ bytes before matching, preventing false framing detection on short input
- **Closed transport guard**: `send()` now rejects with a clear error when called after `close()`, with proper write-error propagation

### Added

- **Dual-framing MCP transport** (`CompatibleStdioServerTransport`): Auto-detects Content-Length (Codex/OpenCode) and newline-delimited JSON (Cursor/Claude Code) framing on the first message, responds in the same format (#207)
- **Lazy CLI module loading**: All CLI subcommands now use `createLazyAction()` to defer heavy imports (tree-sitter, ONNX, KuzuDB) until invocation, significantly improving `gitnexus mcp` startup time (#207)
- **Type-safe lazy actions**: `createLazyAction` uses constrained generics to validate export names against module types at compile time
- **Regression test suite**: 13 unit tests covering transport framing, security hardening, buffer limits, and lazy action loading

### Fixed

- **CALLS edge sourceId alignment**: `findEnclosingFunctionId` now generates IDs with `:startLine` suffix matching node creation format, fixing process detector finding 0 entry points (#194)
- **LRU cache zero maxSize crash**: Guard `createASTCache` against `maxSize=0` when repos have no parseable files (#144)

### Changed

- Transport constructor accepts `NodeJS.ReadableStream` / `NodeJS.WritableStream` (widened from concrete `ReadStream`/`WriteStream`)
- `processReadBuffer` simplified to break on first error instead of stale-buffer retry loop

## [1.3.9] - 2026-03-06

### Fixed

- Aligned CALLS edge sourceId with node ID format in parse worker (#194)

## [1.3.8] - 2026-03-05

### Fixed

- Force-exit after analyze to prevent KuzuDB native cleanup hang (#192)
