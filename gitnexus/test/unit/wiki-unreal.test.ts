import { describe, expect, it } from 'vitest';

import {
  isUnrealAssetPath,
  assetPathToGroupingKey,
} from '../../src/core/wiki/generator.js';

import {
  formatBlueprintSummaries,
  formatAssetDistribution,
  formatGameplayTags,
} from '../../src/core/wiki/prompts.js';

import type { BlueprintAssetInfo, BlueprintEdgeData } from '../../src/core/wiki/graph-queries.js';

describe('wiki unreal helpers', () => {
  // ─── isUnrealAssetPath ───────────────────────────────────────────────

  describe('isUnrealAssetPath', () => {
    it('detects /Game/ asset paths', () => {
      expect(isUnrealAssetPath('/Game/Characters/BP_Hero')).toBe(true);
      expect(isUnrealAssetPath('/Game/UI/WBP_MainMenu')).toBe(true);
    });

    it('detects /Script/ asset paths', () => {
      expect(isUnrealAssetPath('/Script/Engine.Actor')).toBe(true);
    });

    it('detects /Engine/ and /Plugins/ asset paths', () => {
      expect(isUnrealAssetPath('/Engine/BasicShapes/Cube')).toBe(true);
      expect(isUnrealAssetPath('/Plugins/MyPlugin/BP_Foo')).toBe(true);
    });

    it('rejects regular file paths', () => {
      expect(isUnrealAssetPath('Source/S2/GameMode.cpp')).toBe(false);
      expect(isUnrealAssetPath('src/core/wiki/generator.ts')).toBe(false);
      expect(isUnrealAssetPath('Content/Maps/Main.umap')).toBe(false);
    });

    it('handles backslashes', () => {
      expect(isUnrealAssetPath('\\Game\\Characters\\BP_Hero')).toBe(true);
    });
  });

  // ─── assetPathToGroupingKey ──────────────────────────────────────────

  describe('assetPathToGroupingKey', () => {
    it('converts /Game/ to Content/ prefix', () => {
      expect(assetPathToGroupingKey('/Game/Characters/Heroes/BP_Hero')).toBe('Content/Characters/Heroes');
    });

    it('handles shallow paths', () => {
      expect(assetPathToGroupingKey('/Game/BP_Root')).toBe('Content');
    });

    it('caps at 3 directory segments', () => {
      expect(assetPathToGroupingKey('/Game/A/B/C/D/BP_Deep')).toBe('Content/A/B');
    });

    it('handles non-Game prefixes', () => {
      expect(assetPathToGroupingKey('/Engine/BasicShapes/Cube')).toBe('Engine/BasicShapes');
    });
  });

  // ─── formatBlueprintSummaries ────────────────────────────────────────

  describe('formatBlueprintSummaries', () => {
    const makeAsset = (name: string, label: string, assetPath: string): BlueprintAssetInfo => ({
      assetPath, name, label, assetClass: `/Script/Engine.${label}`,
    });

    const makeEdges = (overrides?: Partial<BlueprintEdgeData>): BlueprintEdgeData => ({
      extends: [], calls: [], imports: [],
      implements: [], overrides: [], dispatches: [], gameplayTags: [],
      ...overrides,
    });

    it('formats a Blueprint with all edge types', () => {
      const assets = [makeAsset('BP_Hero', 'Blueprint', '/Game/Characters/BP_Hero')];
      const edges = new Map<string, BlueprintEdgeData>();
      edges.set('/Game/Characters/BP_Hero', makeEdges({
        extends: ['ACharacter'],
        calls: ['GetMovementComponent', 'SetMaxWalkSpeed'],
        implements: ['IInteractable'],
        overrides: ['BeginPlay'],
        gameplayTags: ['Character.Hero'],
      }));

      const result = formatBlueprintSummaries(assets, edges);
      expect(result).toContain('BP_Hero (Blueprint, extends ACharacter)');
      expect(result).toContain('Implements: IInteractable');
      expect(result).toContain('Calls: GetMovementComponent, SetMaxWalkSpeed');
      expect(result).toContain('Overrides: BeginPlay');
      expect(result).toContain('Gameplay Tags: Character.Hero');
    });

    it('handles Blueprints with no edges', () => {
      const assets = [makeAsset('BP_Empty', 'Blueprint', '/Game/BP_Empty')];
      const edges = new Map<string, BlueprintEdgeData>();
      edges.set('/Game/BP_Empty', makeEdges());

      const result = formatBlueprintSummaries(assets, edges);
      expect(result).toContain('BP_Empty (Blueprint)');
      expect(result).not.toContain('Implements');
      expect(result).not.toContain('Calls');
    });

    it('truncates long lists with count', () => {
      const calls = Array.from({ length: 20 }, (_, i) => `Func${i}`);
      const assets = [makeAsset('BP_Big', 'Blueprint', '/Game/BP_Big')];
      const edges = new Map<string, BlueprintEdgeData>();
      edges.set('/Game/BP_Big', makeEdges({ calls }));

      const result = formatBlueprintSummaries(assets, edges);
      expect(result).toContain('(+5 more)');
    });

    it('returns empty message for no assets', () => {
      expect(formatBlueprintSummaries([], new Map())).toBe('No Blueprint assets in this module.');
    });
  });

  // ─── formatAssetDistribution ─────────────────────────────────────────

  describe('formatAssetDistribution', () => {
    it('formats distribution with total', () => {
      const result = formatAssetDistribution({
        Blueprint: 48,
        AnimBlueprint: 12,
        WidgetBlueprint: 8,
      });
      expect(result).toContain('Total: 68 Blueprint assets');
      expect(result).toContain('- Blueprint: 48');
      expect(result).toContain('- AnimBlueprint: 12');
    });

    it('returns empty for no distribution', () => {
      expect(formatAssetDistribution({})).toBe('');
    });
  });

  // ─── formatGameplayTags ──────────────────────────────────────────────

  describe('formatGameplayTags', () => {
    it('formats tags with ref counts', () => {
      const result = formatGameplayTags([
        { tag: 'Ability.Attack.Melee', refCount: 15 },
        { tag: 'Character.Hero', refCount: 8 },
      ]);
      expect(result).toContain('- Ability.Attack.Melee (15 refs)');
      expect(result).toContain('- Character.Hero (8 refs)');
    });

    it('returns message for no tags', () => {
      expect(formatGameplayTags([])).toBe('No gameplay tags indexed.');
    });
  });
});
