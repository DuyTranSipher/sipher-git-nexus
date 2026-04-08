import { describe, it, expect, beforeEach } from 'vitest';
import { ingestBlueprintsIntoGraph } from '../../src/unreal/blueprint-ingestion.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { KnowledgeGraph } from '../../src/core/graph/types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('blueprint-ingestion', () => {
  let graph: KnowledgeGraph;
  let tmpDir: string;

  beforeEach(async () => {
    graph = createKnowledgeGraph();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-ingest-'));
    await fs.mkdir(path.join(tmpDir, 'unreal'), { recursive: true });
  });

  const writeManifest = async (assets: unknown[]) => {
    await fs.writeFile(
      path.join(tmpDir, 'unreal', 'asset-manifest.json'),
      JSON.stringify({ version: 1, generated_at: '2026-01-01', assets }),
    );
  };

  describe('Blueprint-to-Blueprint EXTENDS edges', () => {
    it('creates EXTENDS edge when parent_class points to another Blueprint', async () => {
      // Two Blueprints: Child extends Parent
      await writeManifest([
        {
          asset_path: '/Game/Characters/BP_Parent',
          parent_class: '/Script/Engine.ACharacter',
          native_parents: ['ACharacter'],
        },
        {
          asset_path: '/Game/Characters/BP_Child',
          parent_class: "/Game/Characters/BP_Parent.BP_Parent_C",
          native_parents: ['ACharacter'],
        },
      ]);

      // Add a C++ class node so native_parents can match
      graph.addNode({
        id: 'class-acharacter',
        label: 'Class',
        properties: { name: 'ACharacter', filePath: 'Character.h', startLine: 1, endLine: 100 },
      });

      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);

      expect(result.nodesAdded).toBe(2);

      // Find EXTENDS edges
      const extendsEdges = graph.relationships.filter(r => r.type === 'EXTENDS');

      // Should have: BP_Parent→ACharacter, BP_Child→ACharacter, BP_Child→BP_Parent
      expect(extendsEdges.length).toBe(3);

      // Verify the Blueprint→Blueprint EXTENDS edge exists
      const bpToBpExtends = extendsEdges.find(r => {
        const source = graph.getNode(r.sourceId);
        const target = graph.getNode(r.targetId);
        return source?.properties.name === 'BP_Child' && target?.properties.name === 'BP_Parent';
      });
      expect(bpToBpExtends).toBeDefined();
      expect(bpToBpExtends!.confidence).toBe(0.9);
      expect(bpToBpExtends!.reason).toBe('blueprint-manifest');
    });

    it('handles parent_class with trailing quote notation', async () => {
      await writeManifest([
        { asset_path: '/Game/BP_Base' },
        {
          asset_path: '/Game/BP_Derived',
          parent_class: "Blueprint'/Game/BP_Base.BP_Base_C'",
        },
      ]);

      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);
      expect(result.nodesAdded).toBe(2);

      const extendsEdges = graph.relationships.filter(r => r.type === 'EXTENDS');
      expect(extendsEdges.length).toBe(1);

      const source = graph.getNode(extendsEdges[0].sourceId);
      const target = graph.getNode(extendsEdges[0].targetId);
      expect(source?.properties.name).toBe('BP_Derived');
      expect(target?.properties.name).toBe('BP_Base');
    });

    it('does not create self-referential EXTENDS edge', async () => {
      await writeManifest([
        {
          asset_path: '/Game/BP_Self',
          parent_class: "/Game/BP_Self.BP_Self_C",
        },
      ]);

      await ingestBlueprintsIntoGraph(graph, tmpDir);
      const extendsEdges = graph.relationships.filter(r => r.type === 'EXTENDS');
      expect(extendsEdges.length).toBe(0);
    });

    it('skips EXTENDS when parent_class is a native C++ class (not a Blueprint)', async () => {
      await writeManifest([
        {
          asset_path: '/Game/BP_Hero',
          parent_class: '/Script/Engine.ACharacter',
          native_parents: ['ACharacter'],
        },
      ]);

      graph.addNode({
        id: 'class-acharacter',
        label: 'Class',
        properties: { name: 'ACharacter', filePath: 'Character.h', startLine: 1, endLine: 100 },
      });

      await ingestBlueprintsIntoGraph(graph, tmpDir);

      const extendsEdges = graph.relationships.filter(r => r.type === 'EXTENDS');
      // Only native parent edge, no Blueprint→Blueprint edge
      expect(extendsEdges.length).toBe(1);
      const target = graph.getNode(extendsEdges[0].targetId);
      expect(target?.label).toBe('Class');
    });
  });

  describe('Tier 1 gameplay asset type labels', () => {
    it('maps InputAction asset_class to InputAction label', async () => {
      await writeManifest([
        { asset_path: '/Game/Input/IA_HeavyAttack', asset_class: '/Script/EnhancedInput.InputAction' },
      ]);
      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);
      expect(result.nodesAdded).toBe(1);
      const node = graph.nodes.find(n => n.properties.name === 'IA_HeavyAttack');
      expect(node).toBeDefined();
      expect(node!.label).toBe('InputAction');
    });

    it('maps all new Tier 1 asset classes to correct labels', async () => {
      const assets = [
        { asset_path: '/Game/Input/IA_Attack', asset_class: '/Script/EnhancedInput.InputAction' },
        { asset_path: '/Game/Input/IMC_Default', asset_class: '/Script/EnhancedInput.InputMappingContext' },
        { asset_path: '/Game/AI/BT_Patrol', asset_class: '/Script/AIModule.BehaviorTree' },
        { asset_path: '/Game/AI/BB_Enemy', asset_class: '/Script/AIModule.BlackboardData' },
        { asset_path: '/Game/Anim/AM_Slash', asset_class: '/Script/Engine.AnimMontage' },
        { asset_path: '/Game/AI/SO_CoverPoint', asset_class: '/Script/SmartObjectsModule.SmartObjectDefinition' },
        { asset_path: '/Game/AI/EQS_FindCover', asset_class: '/Script/AIModule.EnvironmentQuery' },
        { asset_path: '/Game/Combat/CG_MeleeCombo', asset_class: '/Script/SipherComboGraph.ComboGraph' },
      ];
      await writeManifest(assets);
      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);
      expect(result.nodesAdded).toBe(8);

      const expectedLabels: Record<string, string> = {
        'IA_Attack': 'InputAction',
        'IMC_Default': 'InputMappingContext',
        'BT_Patrol': 'BehaviorTree',
        'BB_Enemy': 'BlackboardData',
        'AM_Slash': 'AnimMontage',
        'SO_CoverPoint': 'SmartObjectDefinition',
        'EQS_FindCover': 'EnvironmentQuery',
        'CG_MeleeCombo': 'ComboGraph',
      };

      for (const [name, expectedLabel] of Object.entries(expectedLabels)) {
        const node = graph.nodes.find(n => n.properties.name === name);
        expect(node, `node ${name} should exist`).toBeDefined();
        expect(node!.label, `${name} should have label ${expectedLabel}`).toBe(expectedLabel);
      }
    });

    it('metadata-only assets ingest without errors', async () => {
      // Non-Blueprint assets have no generated_class, native_function_refs, or flows
      await writeManifest([
        { asset_path: '/Game/Input/IA_Jump', asset_class: '/Script/EnhancedInput.InputAction' },
      ]);
      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);
      expect(result.nodesAdded).toBe(1);

      // No CALLS, OVERRIDES, or DISPATCHES edges — only the node itself
      const edges = graph.relationships.filter(r =>
        r.type === 'CALLS' || r.type === 'OVERRIDES' || r.type === 'DISPATCHES'
      );
      expect(edges.length).toBe(0);
    });

    it('unknown asset_class falls back to Blueprint label', async () => {
      await writeManifest([
        { asset_path: '/Game/Custom/MyThing', asset_class: '/Script/CustomModule.UnknownAssetType' },
      ]);
      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);
      expect(result.nodesAdded).toBe(1);
      const node = graph.nodes.find(n => n.properties.name === 'MyThing');
      expect(node!.label).toBe('Blueprint');
    });
  });
});
