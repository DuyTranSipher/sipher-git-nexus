/**
 * Centralized Unreal Asset Type Registry
 *
 * Single source of truth for all Unreal asset types indexed by GitNexus.
 * Adding a new type is a one-line addition here — all consumers import
 * derived constants so no other file needs manual updates.
 */

import type { NodeLabel } from '../core/graph/types.js';

export interface UnrealAssetTypeEntry {
  /** NodeLabel used in the graph (e.g., 'InputAction') */
  label: NodeLabel;
  /** UE class names that map to this label (from FAssetData::AssetClassPath) */
  ueClassNames: string[];
  /** FTS index name (e.g., 'inputaction_fts') */
  ftsIndex: string;
  /**
   * Full UE asset class path for C++ discovery via FARFilter.
   * Only needed for non-Blueprint assets (InputAction, BehaviorTree, etc.)
   * that aren't discovered by the default UBlueprint + UStateTree scan.
   * Omit for types already covered (Blueprint, AnimBlueprint, etc.).
   */
  ueClassPath?: string;
  /** If true, the UE module may not exist in all projects (safe to skip) */
  optional?: boolean;
}

export const UNREAL_ASSET_TYPES: readonly UnrealAssetTypeEntry[] = [
  // ── Existing types (discovered via UBlueprint recursive + UStateTree) ──
  { label: 'Blueprint', ueClassNames: ['Blueprint'], ftsIndex: 'blueprint_fts' },
  { label: 'AnimBlueprint', ueClassNames: ['AnimBlueprint'], ftsIndex: 'animblueprint_fts' },
  { label: 'WidgetBlueprint', ueClassNames: ['WidgetBlueprint'], ftsIndex: 'widgetblueprint_fts' },
  { label: 'GameplayAbility', ueClassNames: ['GameplayAbilityBlueprint', 'GameplayAbility'], ftsIndex: 'gameplayability_fts' },
  { label: 'GameplayEffect', ueClassNames: ['GameplayEffectBlueprint', 'GameplayEffect'], ftsIndex: 'gameplayeffect_fts' },
  { label: 'StateTree', ueClassNames: ['StateTree'], ftsIndex: 'statetree_fts' },
  { label: 'DataTable', ueClassNames: ['DataTable'], ftsIndex: 'datatable_fts' },
  { label: 'DataAsset', ueClassNames: ['DataAsset', 'PrimaryDataAsset'], ftsIndex: 'dataasset_fts' },

  // ── Tier 1: Gameplay-critical asset types ──
  { label: 'InputAction', ueClassNames: ['InputAction'], ftsIndex: 'inputaction_fts', ueClassPath: '/Script/EnhancedInput.InputAction' },
  { label: 'InputMappingContext', ueClassNames: ['InputMappingContext'], ftsIndex: 'inputmappingcontext_fts', ueClassPath: '/Script/EnhancedInput.InputMappingContext' },
  { label: 'BehaviorTree', ueClassNames: ['BehaviorTree'], ftsIndex: 'behaviortree_fts', ueClassPath: '/Script/AIModule.BehaviorTree' },
  { label: 'BlackboardData', ueClassNames: ['BlackboardData'], ftsIndex: 'blackboarddata_fts', ueClassPath: '/Script/AIModule.BlackboardData' },
  { label: 'AnimMontage', ueClassNames: ['AnimMontage'], ftsIndex: 'animmontage_fts', ueClassPath: '/Script/Engine.AnimMontage' },
  { label: 'SmartObjectDefinition', ueClassNames: ['SmartObjectDefinition'], ftsIndex: 'smartobjectdefinition_fts', ueClassPath: '/Script/SmartObjectsModule.SmartObjectDefinition', optional: true },
  { label: 'EnvironmentQuery', ueClassNames: ['EnvironmentQuery'], ftsIndex: 'environmentquery_fts', ueClassPath: '/Script/AIModule.EnvironmentQuery' },
  { label: 'ComboGraph', ueClassNames: ['ComboGraph'], ftsIndex: 'combograph_fts', ueClassPath: '/Script/SipherComboGraph.ComboGraph', optional: true },
];

// ── Derived constants (consumed by schema, FTS, search, query, CSV, wiki) ──

/** All UE asset node labels (for schema, CSV, VALID_NODE_LABELS, wiki queries) */
export const UE_ASSET_LABELS: NodeLabel[] = UNREAL_ASSET_TYPES.map(t => t.label);

/** UE class name → NodeLabel lookup (for assetClassToLabel in blueprint-ingestion) */
export const UE_LABEL_MAP: Record<string, NodeLabel> = Object.fromEntries(
  UNREAL_ASSET_TYPES.flatMap(t => t.ueClassNames.map(cn => [cn, t.label]))
);

/** FTS table pairs: [tableName, indexName] (for analyze.ts, bm25-index.ts, local-backend.ts) */
export const UE_FTS_TABLES: [string, string][] = UNREAL_ASSET_TYPES.map(t => [t.label, t.ftsIndex]);

/** Extra asset class paths for C++ commandlet discovery (for bridge.ts → filter JSON) */
export const UE_EXTRA_CLASS_PATHS: string[] = UNREAL_ASSET_TYPES
  .filter(t => t.ueClassPath)
  .map(t => t.ueClassPath!);
