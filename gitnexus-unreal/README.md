# GitNexus Unreal

Unreal Editor plugin and commandlet for GitNexus Blueprint reference analysis.

## What It Does

`GitNexusBlueprintAnalyzer` is the Unreal-side analyzer that GitNexus calls for:

- Blueprint asset manifest sync
- Direct Blueprint reference lookup for native C++ functions
- Local Blueprint chain expansion from a confirmed graph node

GitNexus stores the synced manifest under `.gitnexus/unreal/asset-manifest.json` inside the indexed repo. The TypeScript side uses that manifest to shortlist candidate Blueprints before asking Unreal to confirm exact graph nodes.

## Install

Copy `GitNexusUnreal/` into your Unreal project's `Plugins/` folder, then regenerate project files and build the editor target.

## GitNexus Config

Create `.gitnexus/unreal/config.json` in the indexed repo:

```json
{
  "editor_cmd": "C:/Program Files/Epic Games/UE_5.5/Engine/Binaries/Win64/UnrealEditor-Cmd.exe",
  "project_path": "D:/Projects/sipher_test_project/sipher_test_project.uproject",
  "commandlet": "GitNexusBlueprintAnalyzer",
  "timeout_ms": 300000
}
```

## Expected Operations

- `SyncAssets`
  Writes a manifest JSON payload with Blueprint assets, native ancestry, dependencies, and native call references.
- `FindNativeBlueprintReferences`
  Consumes a candidate asset list and returns confirmed call/event nodes for a native function.
- `ExpandBlueprintChain`
  Traverses upstream/downstream graph links from a returned `chain_anchor_id`.
