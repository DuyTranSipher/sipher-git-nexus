import fs from 'fs/promises';
import path from 'path';
import type {
  UnrealAssetManifest,
  UnrealConfig,
  UnrealStoragePaths,
} from './types.js';

export function getUnrealStoragePaths(storagePath: string): UnrealStoragePaths {
  const rootDir = path.join(storagePath, 'unreal');
  return {
    root_dir: rootDir,
    config_path: path.join(rootDir, 'config.json'),
    manifest_path: path.join(rootDir, 'asset-manifest.json'),
    requests_dir: path.join(rootDir, 'requests'),
    outputs_dir: path.join(rootDir, 'outputs'),
  };
}

export async function ensureUnrealStorage(storagePath: string): Promise<UnrealStoragePaths> {
  const paths = getUnrealStoragePaths(storagePath);
  await fs.mkdir(paths.requests_dir, { recursive: true });
  await fs.mkdir(paths.outputs_dir, { recursive: true });
  return paths;
}

export async function loadUnrealConfig(storagePath: string): Promise<UnrealConfig | null> {
  try {
    const paths = getUnrealStoragePaths(storagePath);
    const raw = await fs.readFile(paths.config_path, 'utf-8');
    const parsed = JSON.parse(raw) as UnrealConfig;
    if (!parsed.editor_cmd || !parsed.project_path) {
      return null;
    }
    return {
      commandlet: 'GitNexusBlueprintAnalyzer',
      timeout_ms: 300000,
      ...parsed,
    };
  } catch {
    return null;
  }
}

export async function loadUnrealAssetManifest(storagePath: string): Promise<UnrealAssetManifest | null> {
  try {
    const paths = getUnrealStoragePaths(storagePath);
    const raw = await fs.readFile(paths.manifest_path, 'utf-8');
    const parsed = JSON.parse(raw) as UnrealAssetManifest;
    if (!Array.isArray(parsed.assets)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveUnrealAssetManifest(storagePath: string, manifest: UnrealAssetManifest): Promise<string> {
  const paths = await ensureUnrealStorage(storagePath);
  await fs.writeFile(paths.manifest_path, JSON.stringify(manifest, null, 2), 'utf-8');
  return paths.manifest_path;
}
