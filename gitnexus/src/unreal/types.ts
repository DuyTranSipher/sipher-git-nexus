export interface UnrealAssetManifestAsset {
  asset_path: string;
  generated_class?: string;
  parent_class?: string;
  native_parents?: string[];
  native_function_refs?: string[];
  dependencies?: string[];
}

export interface UnrealAssetManifest {
  version: number;
  generated_at: string;
  project_path?: string;
  assets: UnrealAssetManifestAsset[];
}

export interface UnrealConfig {
  editor_cmd: string;
  project_path: string;
  commandlet?: string;
  timeout_ms?: number;
  working_directory?: string;
  extra_args?: string[];
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

export interface UnrealChainNode {
  node_id: string;
  graph_name?: string;
  node_kind: string;
  node_title?: string;
  depth: number;
}

export interface SyncUnrealAssetManifestResult {
  status: 'success' | 'error';
  manifest_path?: string;
  asset_count?: number;
  generated_at?: string;
  warnings?: string[];
  error?: string;
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
