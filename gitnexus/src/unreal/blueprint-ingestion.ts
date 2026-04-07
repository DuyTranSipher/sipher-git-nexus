/**
 * Blueprint Ingestion — adds Unreal Blueprint assets to the knowledge graph
 *
 * Reads the asset manifest (produced by `gitnexus unreal-sync`) and creates
 * Blueprint nodes plus edges to C++ classes and functions already in the graph.
 * Runs as a post-pipeline step before LadybugDB loading.
 */

import fs from 'fs/promises';
import path from 'path';
import { KnowledgeGraph, GraphNode, NodeLabel } from '../core/graph/types.js';
import { generateId } from '../lib/utils.js';
import { shouldIgnorePath, loadIgnoreRules } from '../config/ignore-service.js';
import type { UnrealAssetManifest } from './types.js';

export interface BlueprintIngestionResult {
  nodesAdded: number;
  edgesAdded: number;
}

/**
 * Tokenize an Unreal asset name for FTS indexability.
 * LadybugDB's FTS tokenizer splits on whitespace only — underscores are
 * treated as word characters, so "GA_ArtifactCombo_GenericAbility" is one
 * opaque token. This function produces a space-separated list of subwords
 * suitable for porter-stemmer matching.
 *
 * "GA_ArtifactCombo_GenericAbility" →
 *   "GA Artifact Combo Generic Ability ga artifact combo generic ability"
 */
export const tokenizeBlueprintName = (name: string): string => {
  // Split on underscores first
  const underscoreParts = name.split('_').filter(Boolean);
  // Split each part on camelCase boundaries
  const words = underscoreParts.flatMap(p =>
    p.replace(/([A-Z][a-z])/g, ' $1')
     .replace(/([a-z])([A-Z])/g, '$1 $2')
     .trim()
     .split(/\s+/)
     .filter(Boolean)
  );
  // Combine original parts + split words + lowercase variants for stemming
  const all = [...new Set([...underscoreParts, ...words])];
  return [...all, ...all.map(w => w.toLowerCase())].join(' ');
};

/** Extract a display name from an Unreal asset path (last segment). */
const extractAssetName = (assetPath: string): string => {
  // "/Game/Characters/BP_Hero" → "BP_Hero"
  // "/Game/Characters/BP_Hero.BP_Hero_C" → "BP_Hero"
  const lastSlash = assetPath.lastIndexOf('/');
  const segment = lastSlash >= 0 ? assetPath.slice(lastSlash + 1) : assetPath;
  const dotIdx = segment.indexOf('.');
  return dotIdx >= 0 ? segment.slice(0, dotIdx) : segment;
};

/** Extract a C++ class name from an Unreal class path.
 *  "/Script/Engine.Character" → "Character"
 *  "/Script/Engine.ACharacter" → "ACharacter"
 *  "ACharacter" → "ACharacter" (already plain)
 */
const extractClassName = (unrealPath: string): string => {
  const dotIdx = unrealPath.lastIndexOf('.');
  if (dotIdx >= 0) return unrealPath.slice(dotIdx + 1);
  const slashIdx = unrealPath.lastIndexOf('/');
  return slashIdx >= 0 ? unrealPath.slice(slashIdx + 1) : unrealPath;
};

/** Map an Unreal asset class path to a typed NodeLabel.
 *  Falls back to 'Blueprint' for unknown/missing asset classes. */
const assetClassToLabel = (assetClass?: string): NodeLabel => {
  if (!assetClass) return 'Blueprint';
  // Extract class name from path: "/Script/Engine.AnimBlueprint" → "AnimBlueprint"
  const dot = assetClass.lastIndexOf('.');
  const className = dot >= 0 ? assetClass.slice(dot + 1) : assetClass;

  const LABEL_MAP: Record<string, NodeLabel> = {
    'AnimBlueprint': 'AnimBlueprint',
    'WidgetBlueprint': 'WidgetBlueprint',
    'GameplayAbilityBlueprint': 'GameplayAbility',
    'GameplayAbility': 'GameplayAbility',
    'GameplayEffectBlueprint': 'GameplayEffect',
    'GameplayEffect': 'GameplayEffect',
    'StateTree': 'StateTree',
    'DataTable': 'DataTable',
    'DataAsset': 'DataAsset',
    // Common subclasses that should map to the parent type
    'PrimaryDataAsset': 'DataAsset',
  };

  return LABEL_MAP[className] || 'Blueprint';
};

/**
 * Convert an Unreal asset path to a filesystem-relative path for ignore matching.
 * "/Game/Characters/BP_Hero"       → "Content/Characters/BP_Hero"
 * "/MyPlugin/Maps/TestMap"         → "Plugins/MyPlugin/Content/Maps/TestMap"
 * "/Engine/BasicShapes/Cube"       → "Engine/Content/BasicShapes/Cube"
 */
export const assetPathToRelative = (assetPath: string): string => {
  // Strip leading slash
  const trimmed = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx < 0) return trimmed;

  const mount = trimmed.slice(0, slashIdx);
  const rest = trimmed.slice(slashIdx + 1);

  if (mount === 'Game') return `Content/${rest}`;
  if (mount === 'Engine') return `Engine/Content/${rest}`;
  // Plugin mounts: /PluginName/X → Plugins/PluginName/Content/X
  return `Plugins/${mount}/Content/${rest}`;
};

/**
 * Ingest Blueprint assets from the Unreal asset manifest into the knowledge graph.
 * Creates Blueprint nodes and edges (EXTENDS, CALLS, IMPORTS) linking them to
 * existing C++ symbols in the graph.
 */
export const ingestBlueprintsIntoGraph = async (
  graph: KnowledgeGraph,
  storagePath: string,
  repoPath?: string,
): Promise<BlueprintIngestionResult> => {
  const manifestPath = path.join(storagePath, 'unreal', 'asset-manifest.json');

  let manifest: UnrealAssetManifest;
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(raw);
  } catch {
    return { nodesAdded: 0, edgesAdded: 0 };
  }

  if (!manifest.assets || manifest.assets.length === 0) {
    return { nodesAdded: 0, edgesAdded: 0 };
  }

  // ── Filter assets through ignore rules ─────────────────────────────
  const ig = repoPath ? await loadIgnoreRules(repoPath) : null;
  const assets = manifest.assets.filter(asset => {
    const relPath = assetPathToRelative(asset.asset_path);
    if (shouldIgnorePath(relPath)) return false;
    if (ig && ig.ignores(relPath)) return false;
    return true;
  });

  // ── Build lookup indexes from existing graph nodes ──────────────────

  // Class/Struct nodes keyed by name (for parent class matching)
  const classByName = new Map<string, GraphNode[]>();
  // Method/Function nodes keyed by name (for native_function_refs matching)
  const symbolByName = new Map<string, GraphNode[]>();
  // Class ID → set of Method IDs (via HAS_METHOD edges)
  const classMethodIds = new Map<string, Set<string>>();

  // Build class→method map from HAS_METHOD edges
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'HAS_METHOD') {
      let methods = classMethodIds.get(rel.sourceId);
      if (!methods) { methods = new Set(); classMethodIds.set(rel.sourceId, methods); }
      methods.add(rel.targetId);
    }
  }

  for (const node of graph.iterNodes()) {
    if (node.label === 'Class' || node.label === 'Struct') {
      const name = node.properties.name;
      let list = classByName.get(name);
      if (!list) { list = []; classByName.set(name, list); }
      list.push(node);
    }
    if (node.label === 'Method' || node.label === 'Function') {
      const name = node.properties.name;
      let list = symbolByName.get(name);
      if (!list) { list = []; symbolByName.set(name, list); }
      list.push(node);
    }
  }

  // Reverse map: method ID → owning class name (for disambiguation)
  const methodOwnerName = new Map<string, string>();
  for (const [classId, methodIds] of classMethodIds) {
    const classNode = graph.getNode(classId);
    if (!classNode) continue;
    for (const methodId of methodIds) {
      methodOwnerName.set(methodId, classNode.properties.name);
    }
  }

  // ── Create Blueprint nodes and edges ────────────────────────────────

  let nodesAdded = 0;
  let edgesAdded = 0;
  let edgeCounter = 0;

  // Track created Blueprint IDs for second-pass dependency and inheritance edges
  const blueprintIdByAssetPath = new Map<string, string>();
  const blueprintIdByName = new Map<string, string>();

  for (const asset of assets) {
    const bpId = generateId('Blueprint', asset.asset_path);
    const bpName = extractAssetName(asset.asset_path);

    const label = assetClassToLabel(asset.asset_class);
    graph.addNode({
      id: bpId,
      label,
      properties: {
        name: bpName,
        filePath: asset.asset_path,
        startLine: -1,
        endLine: -1,
        // Tokenized name enables FTS to match underscore/camelCase terms individually.
        // e.g. "GA_ArtifactCombo_GenericAbility" → "GA Artifact Combo Generic Ability ..."
        description: tokenizeBlueprintName(bpName) + (asset.generated_class ? ' ' + asset.generated_class : ''),
        ueAssetClass: asset.asset_class,
      },
    });
    nodesAdded++;
    blueprintIdByAssetPath.set(asset.asset_path, bpId);
    blueprintIdByName.set(bpName, bpId);

    // ── EXTENDS edge to nearest native parent class ──────────────
    const nativeParents = asset.native_parents || [];
    if (nativeParents.length > 0) {
      const parentClassName = extractClassName(nativeParents[0]);
      const candidates = classByName.get(parentClassName);
      if (candidates && candidates.length > 0) {
        const target = candidates[0]; // pick first match
        graph.addRelationship({
          id: generateId('EXTENDS', `${bpId}->${target.id}:${edgeCounter++}`),
          sourceId: bpId,
          targetId: target.id,
          type: 'EXTENDS',
          confidence: 0.9,
          reason: 'blueprint-manifest',
        });
        edgesAdded++;
      }
    }

    // ── CALLS edges for native function references ───────────────
    const funcRefs = asset.native_function_refs || [];
    for (const ref of funcRefs) {
      const colonIdx = ref.lastIndexOf('::');
      let targetClassName: string | undefined;
      let funcName: string;
      if (colonIdx >= 0) {
        targetClassName = ref.slice(0, colonIdx);
        funcName = ref.slice(colonIdx + 2);
      } else {
        funcName = ref;
      }

      const candidates = symbolByName.get(funcName);
      if (!candidates || candidates.length === 0) continue;

      // If we have a class name, prefer methods owned by that class
      let matched: GraphNode | undefined;
      if (targetClassName) {
        matched = candidates.find(c => {
          const owner = methodOwnerName.get(c.id);
          return owner === targetClassName;
        });
      }
      // Fallback: first candidate
      if (!matched) matched = candidates[0];

      // Boost confidence if the target has BlueprintCallable specifier
      const specs = matched.properties.ueSpecifiers;
      const isBlueprintCallable = specs?.some(s =>
        s === 'BlueprintCallable' || s === 'BlueprintPure'
      );
      const confidence = isBlueprintCallable ? 1.0 : 0.8;

      graph.addRelationship({
        id: generateId('CALLS', `${bpId}->${matched.id}:${edgeCounter++}`),
        sourceId: bpId,
        targetId: matched.id,
        type: 'CALLS',
        confidence,
        reason: isBlueprintCallable ? 'blueprint-callable' : 'blueprint-manifest',
      });
      edgesAdded++;
    }
  }

  // ── Second pass: Blueprint-to-Blueprint EXTENDS edges ───────────────
  // Uses the `parent_class` field which points to the direct parent (may be
  // another Blueprint). The first pass already created Blueprint→C++ EXTENDS
  // edges via `native_parents`; this pass fills the Blueprint→Blueprint gap.
  for (const asset of assets) {
    if (!asset.parent_class) continue;

    const sourceBpId = blueprintIdByAssetPath.get(asset.asset_path);
    if (!sourceBpId) continue;

    // parent_class is a class path like "/Script/Game.ALS_Base_CharacterBP_C"
    // or "Blueprint'/Game/Path/BP_Foo.BP_Foo_C'" — extract class name, strip _C
    let parentName = extractClassName(asset.parent_class);
    parentName = parentName.replace(/'$/, ''); // strip trailing quote
    if (parentName.endsWith('_C')) {
      parentName = parentName.slice(0, -2);
    }

    const targetBpId = blueprintIdByName.get(parentName);
    if (targetBpId && targetBpId !== sourceBpId) {
      graph.addRelationship({
        id: generateId('EXTENDS', `${sourceBpId}->${targetBpId}:${edgeCounter++}`),
        sourceId: sourceBpId,
        targetId: targetBpId,
        type: 'EXTENDS',
        confidence: 0.9,
        reason: 'blueprint-manifest',
      });
      edgesAdded++;
    }
  }

  // ── Third pass: Blueprint-to-Blueprint IMPORTS edges ───────────────
  for (const asset of assets) {
    const deps = asset.dependencies || [];
    if (deps.length === 0) continue;

    const sourceBpId = blueprintIdByAssetPath.get(asset.asset_path);
    if (!sourceBpId) continue;

    for (const dep of deps) {
      const targetBpId = blueprintIdByAssetPath.get(dep);
      if (!targetBpId || targetBpId === sourceBpId) continue;

      graph.addRelationship({
        id: generateId('IMPORTS', `${sourceBpId}->${targetBpId}:${edgeCounter++}`),
        sourceId: sourceBpId,
        targetId: targetBpId,
        type: 'IMPORTS',
        confidence: 0.7,
        reason: 'blueprint-manifest',
      });
      edgesAdded++;
    }
  }

  // ── Fourth pass: Cross-language edges (deep mode only) ─────────────
  // IMPLEMENTS: Blueprint → C++ Interface class
  // OVERRIDES: Blueprint → C++ event function (BlueprintNativeEvent/BlueprintImplementableEvent)
  // DISPATCHES: Blueprint → C++ event dispatcher delegate
  for (const asset of assets) {
    const sourceBpId = blueprintIdByAssetPath.get(asset.asset_path);
    if (!sourceBpId) continue;

    // IMPLEMENTS edges for Blueprint interfaces
    const interfaces = asset.implements_interfaces || [];
    for (const iface of interfaces) {
      const ifaceName = extractClassName(iface);
      // Look for Interface or Class node matching the interface name
      const candidates = classByName.get(ifaceName);
      if (candidates && candidates.length > 0) {
        graph.addRelationship({
          id: generateId('IMPLEMENTS', `${sourceBpId}->${candidates[0].id}:${edgeCounter++}`),
          sourceId: sourceBpId,
          targetId: candidates[0].id,
          type: 'IMPLEMENTS',
          confidence: 1.0,
          reason: 'blueprint-interface',
        });
        edgesAdded++;
      }
    }

    // OVERRIDES edges for event overrides
    const overrides = asset.event_overrides || [];
    for (const override of overrides) {
      const funcCandidates = symbolByName.get(override.event_name);
      if (!funcCandidates || funcCandidates.length === 0) continue;

      // Prefer method owned by the specified class
      let matched: GraphNode | undefined;
      if (override.owner_class) {
        matched = funcCandidates.find(c => {
          const owner = methodOwnerName.get(c.id);
          return owner === override.owner_class;
        });
      }
      if (!matched) matched = funcCandidates[0];

      graph.addRelationship({
        id: generateId('OVERRIDES', `${sourceBpId}->${matched.id}:${edgeCounter++}`),
        sourceId: sourceBpId,
        targetId: matched.id,
        type: 'OVERRIDES',
        confidence: 1.0,
        reason: 'blueprint-event-override',
      });
      edgesAdded++;
    }

    // DISPATCHES edges for event dispatcher bindings
    const dispatchers = asset.event_dispatchers || [];
    for (const dispatcherName of dispatchers) {
      const funcCandidates = symbolByName.get(dispatcherName);
      if (!funcCandidates || funcCandidates.length === 0) continue;

      graph.addRelationship({
        id: generateId('DISPATCHES', `${sourceBpId}->${funcCandidates[0].id}:${edgeCounter++}`),
        sourceId: sourceBpId,
        targetId: funcCandidates[0].id,
        type: 'DISPATCHES',
        confidence: 0.9,
        reason: 'blueprint-event-dispatcher',
      });
      edgesAdded++;
    }
  }

  // ── Fifth pass: REFERENCES_TAG edges (Gameplay Tags) ──────────────
  for (const asset of assets) {
    const tags = asset.gameplay_tags || [];
    if (tags.length === 0) continue;

    const sourceBpId = blueprintIdByAssetPath.get(asset.asset_path);
    if (!sourceBpId) continue;

    for (const tag of tags) {
      const tagNodeId = generateId('GameplayTag', tag);
      // Only create edge if the tag node exists in the graph
      if (!graph.getNode(tagNodeId)) continue;

      graph.addRelationship({
        id: generateId('REFERENCES_TAG', `${sourceBpId}->${tagNodeId}:${edgeCounter++}`),
        sourceId: sourceBpId,
        targetId: tagNodeId,
        type: 'REFERENCES_TAG',
        confidence: 0.9,
        reason: 'blueprint-gameplay-tag',
      });
      edgesAdded++;
    }
  }

  // ── Sixth pass: Blueprint Execution Flows as Process nodes ─────
  for (const asset of assets) {
    const flows = asset.flows || [];
    if (flows.length === 0) continue;

    const ownerBpId = blueprintIdByAssetPath.get(asset.asset_path);
    if (!ownerBpId) continue;
    const bpName = extractAssetName(asset.asset_path);

    for (const flow of flows) {
      if (!flow.steps || flow.steps.length === 0) continue;

      const processName = `${bpName}::${flow.event_name}`;
      const processId = generateId('Process', `bp:${asset.asset_path}:${flow.event_name}`);

      graph.addNode({
        id: processId,
        label: 'Process',
        properties: {
          name: processName,
          filePath: asset.asset_path,
          startLine: -1,
          endLine: -1,
          processType: 'intra_community',
          stepCount: flow.steps.length,
          description: `Blueprint event flow: ${flow.event_name}`,
        },
      });
      nodesAdded++;

      // CONTAINS: owning Blueprint → Process
      graph.addRelationship({
        id: generateId('CONTAINS', `${ownerBpId}->${processId}:${edgeCounter++}`),
        sourceId: ownerBpId,
        targetId: processId,
        type: 'CONTAINS',
        confidence: 1.0,
        reason: 'blueprint-flow-owner',
      });
      edgesAdded++;

      // STEP_IN_PROCESS: link the owning Blueprint as a participant
      graph.addRelationship({
        id: generateId('STEP_IN_PROCESS', `${ownerBpId}->${processId}:${edgeCounter++}`),
        sourceId: ownerBpId,
        targetId: processId,
        type: 'STEP_IN_PROCESS',
        confidence: 1.0,
        reason: 'blueprint-flow-entry',
        step: 1,
      });
      edgesAdded++;

      // For steps that are CallFunction nodes, try to link to C++ symbols
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        if (!step.node_title) continue;
        // CallFunction nodes have titles like "ClassName::FunctionName" or just "FunctionName"
        const colonIdx = step.node_title.lastIndexOf('::');
        const funcName = colonIdx >= 0 ? step.node_title.slice(colonIdx + 2) : step.node_title;
        // Skip common non-function nodes
        if (funcName === 'Sequence' || funcName === 'Branch' || funcName.startsWith('K2Node_')) continue;

        const candidates = symbolByName.get(funcName);
        if (candidates && candidates.length > 0) {
          graph.addRelationship({
            id: generateId('STEP_IN_PROCESS', `${candidates[0].id}->${processId}:${edgeCounter++}`),
            sourceId: candidates[0].id,
            targetId: processId,
            type: 'STEP_IN_PROCESS',
            confidence: 0.7,
            reason: 'blueprint-flow-step',
            step: i + 2,
          });
          edgesAdded++;
        }
      }
    }
  }

  return { nodesAdded, edgesAdded };
};
