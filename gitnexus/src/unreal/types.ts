export interface UnrealAssetManifestAsset {
  asset_path: string;
  /** Unreal asset class path from FAssetData::AssetClassPath (e.g. "/Script/Engine.AnimBlueprint") */
  asset_class?: string;
  generated_class?: string;
  parent_class?: string;
  native_parents?: string[];
  native_function_refs?: string[];
  dependencies?: string[];
  /** Blueprint interfaces implemented by this asset (deep mode only) */
  implements_interfaces?: string[];
  /** Event overrides — functions from parent class overridden in this Blueprint (deep mode only) */
  event_overrides?: { event_name: string; owner_class: string }[];
  /** Event dispatcher delegate names bound in this Blueprint (deep mode only) */
  event_dispatchers?: string[];
  /** Gameplay tags referenced by this asset (deep mode only) */
  gameplay_tags?: string[];
  /** Blueprint execution flows extracted at index time (deep mode only) */
  flows?: { event_name: string; steps: UnrealChainNode[] }[];
  /** ISO timestamp of the .uasset file's last modification time. Used for incremental change detection. */
  file_modified_at?: string;
}

export interface UnrealAssetManifest {
  version: number;
  generated_at: string;
  project_path?: string;
  mode?: 'metadata' | 'deep';
  assets: UnrealAssetManifestAsset[];
}

/** Raw commandlet output for SyncAssets — extends manifest with incremental skip data. */
export interface UnrealSyncCommandletResponse extends UnrealAssetManifest {
  /** Asset paths that were skipped because they were in the known_paths list (deep mode only). */
  skipped_paths?: string[];
}

export interface UnrealConfig {
  editor_cmd: string;
  project_path: string;
  commandlet?: string;
  timeout_ms?: number;
  working_directory?: string;
  extra_args?: string[];
  /**
   * Paths to exclude from sync. Accepts:
   *   - Unreal package path prefixes: "/Game/ThirdParty", "/SomePlugin"
   *   - Filesystem-relative paths: "Content/ThirdParty" (auto-converted to "/Game/ThirdParty")
   *   - Glob patterns: "/Game/**\/ST_*", "Content/**\/ThirdParty\/**"
   *     (* = non-separator chars, ** = any chars including /)
   *   - Regex patterns: "regex:/Game/ST_" (partial match; use ^ and $ to anchor)
   */
  exclude_paths?: string[];
  /**
   * Paths to include (whitelist). If set, ONLY assets matching these entries are scanned.
   * Accepts the same formats as exclude_paths: prefixes, filesystem paths,
   * glob patterns ("**\/ST_*"), or "regex:" patterns.
   */
  include_paths?: string[];
}

export interface UnrealStoragePaths {
  root_dir: string;
  config_path: string;
  manifest_path: string;
  requests_dir: string;
  outputs_dir: string;
}

export interface NativeFunctionTarget {
  symbol_id: string;
  symbol_name: string;
  symbol_type: string;
  symbol_key: string;
  qualified_name: string;
  class_name?: string;
  file_path?: string;
  start_line?: number;
}

export interface UnrealBlueprintCandidate {
  asset_path: string;
  generated_class?: string;
  parent_class?: string;
  reason: 'native_parent' | 'native_function_ref' | 'dependency' | 'manifest';
}

export interface UnrealConfirmedReference {
  asset_path: string;
  graph_name?: string;
  node_kind: string;
  node_title?: string;
  blueprint_owner_function?: string;
  chain_anchor_id: string;
  source: 'editor_confirmed';
}

export interface UnrealChainNodePin {
  name: string;
  direction: 'input' | 'output';
  type: string;
  sub_type?: string;
  default_value?: string;
  connected_to?: string[];
  connected_to_title?: string[];
}

export interface UnrealChainNodePins {
  exec_pins: UnrealChainNodePin[];
  data_pins: UnrealChainNodePin[];
}

export interface UnrealChainNodeDetails {
  // UK2Node_CallFunction
  is_pure?: boolean;
  target_class?: string;
  function_name?: string;
  // UK2Node_VariableGet / UK2Node_VariableSet
  variable_name?: string;
  node_role?: 'variable_get' | 'variable_set';
  // UK2Node_IfThenElse / UK2Node_Switch
  branch_type?: 'if_then_else' | 'switch';
}

export interface UnrealChainNode {
  node_id: string;
  graph_name?: string;
  node_kind: string;
  node_title?: string;
  depth: number;
  // Phase 2: node metadata
  is_enabled?: boolean;
  comment?: string;
  // Phase 3: BFS traversal context
  traversed_from_pin?: string;
  traversed_from_node?: string;
  // Phase 1: pin data
  pins?: UnrealChainNodePins;
  // Phase 2: type-specific details
  details?: UnrealChainNodeDetails;
}

export interface SyncUnrealAssetManifestResult {
  status: 'success' | 'error';
  manifest_path?: string;
  asset_count?: number;
  generated_at?: string;
  warnings?: string[];
  error?: string;
  /** Number of assets skipped during incremental deep sync. */
  skipped_count?: number;
  /** Number of newly-processed assets during incremental deep sync. */
  new_count?: number;
}

export interface FindNativeBlueprintReferencesResult {
  target_function: NativeFunctionTarget;
  candidates_scanned: number;
  candidate_assets: UnrealBlueprintCandidate[];
  confirmed_references: UnrealConfirmedReference[];
  manifest_path?: string;
  manifest_refreshed?: boolean;
  warnings?: string[];
}

export interface ExpandBlueprintChainResult {
  asset_path: string;
  chain_anchor_id: string;
  direction: 'upstream' | 'downstream';
  max_depth: number;
  nodes: UnrealChainNode[];
  warnings?: string[];
}

export interface DerivedBlueprintResult {
  class_name: string;
  manifest_path: string;
  blueprints: UnrealBlueprintCandidate[];
}

export interface UnrealAnalyzerSyncResponse {
  manifest: UnrealAssetManifest;
  warnings?: string[];
}

export interface UnrealAnalyzerFindRefsResponse {
  target_function?: Partial<NativeFunctionTarget>;
  candidates_scanned?: number;
  confirmed_references?: UnrealConfirmedReference[];
  warnings?: string[];
}

export interface UnrealAnalyzerExpandChainResponse {
  nodes?: UnrealChainNode[];
  warnings?: string[];
}
