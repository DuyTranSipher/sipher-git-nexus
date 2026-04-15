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

  describe('Blueprint-to-Blueprint IMPORTS edges (dependencies)', () => {
    it('creates IMPORTS edges when dependencies use package paths (no dot suffix)', async () => {
      // Real manifests use full object paths for asset_path but package paths for dependencies.
      // asset_path: "/Game/X/BP_Foo.BP_Foo"  (full object path)
      // dependency:  "/Game/X/BP_Foo"          (package path — from AssetRegistry::GetDependencies)
      await writeManifest([
        {
          asset_path: '/Game/Anim/ABP_Main.ABP_Main',
          asset_class: '/Script/Engine.AnimBlueprint',
          dependencies: [
            '/Game/Anim/ABP_Sub',         // another Blueprint (package path format)
            '/Script/Engine',              // C++ module (should be skipped)
            '/Game/Anim/ABP_Main',         // self-reference (should be skipped)
          ],
        },
        {
          asset_path: '/Game/Anim/ABP_Sub.ABP_Sub',
          asset_class: '/Script/Engine.AnimBlueprint',
          dependencies: [],
        },
      ]);

      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);
      expect(result.nodesAdded).toBe(2);

      const importsEdges = graph.relationships.filter(r => r.type === 'IMPORTS');
      expect(importsEdges.length).toBe(1);

      const source = graph.getNode(importsEdges[0].sourceId);
      const target = graph.getNode(importsEdges[0].targetId);
      expect(source?.properties.name).toBe('ABP_Main');
      expect(target?.properties.name).toBe('ABP_Sub');
      expect(importsEdges[0].confidence).toBe(0.7);
      expect(importsEdges[0].reason).toBe('blueprint-manifest');
    });

    it('creates IMPORTS edges when dependencies use full object paths', async () => {
      // Some dependencies may also use full object paths (matching asset_path format)
      await writeManifest([
        {
          asset_path: '/Game/BP_A.BP_A',
          dependencies: ['/Game/BP_B.BP_B'],
        },
        {
          asset_path: '/Game/BP_B.BP_B',
          dependencies: [],
        },
      ]);

      await ingestBlueprintsIntoGraph(graph, tmpDir);

      const importsEdges = graph.relationships.filter(r => r.type === 'IMPORTS');
      expect(importsEdges.length).toBe(1);

      const source = graph.getNode(importsEdges[0].sourceId);
      const target = graph.getNode(importsEdges[0].targetId);
      expect(source?.properties.name).toBe('BP_A');
      expect(target?.properties.name).toBe('BP_B');
    });

    it('skips dependencies that do not resolve to indexed Blueprints', async () => {
      await writeManifest([
        {
          asset_path: '/Game/BP_Hero.BP_Hero',
          dependencies: [
            '/Script/PhysicsCore',
            '/Script/GameplayTags',
            '/Game/Textures/T_Diffuse',  // not a Blueprint asset in manifest
          ],
        },
      ]);

      await ingestBlueprintsIntoGraph(graph, tmpDir);

      const importsEdges = graph.relationships.filter(r => r.type === 'IMPORTS');
      expect(importsEdges.length).toBe(0);
    });
  });

  describe('SCS component USES edges', () => {
    it('creates USES edge from Blueprint to C++ component class', async () => {
      await writeManifest([
        {
          asset_path: '/Game/BP_Hero',
          native_parents: ['ACharacter'],
          components: [
            { name: 'RootComp', component_class: 'SceneComponent' },
            { name: 'MeshComp', component_class: 'StaticMeshComponent', parent_name: 'RootComp' },
            { name: 'CameraComp', component_class: 'CameraComponent', parent_name: 'RootComp' },
          ],
        },
      ]);

      // Add C++ class nodes for components
      graph.addNode({
        id: 'class-scenecomp',
        label: 'Class',
        properties: { name: 'SceneComponent', filePath: 'SceneComponent.h', startLine: 1, endLine: 100 },
      });
      graph.addNode({
        id: 'class-staticmesh',
        label: 'Class',
        properties: { name: 'StaticMeshComponent', filePath: 'StaticMeshComponent.h', startLine: 1, endLine: 100 },
      });
      graph.addNode({
        id: 'class-camera',
        label: 'Class',
        properties: { name: 'CameraComponent', filePath: 'CameraComponent.h', startLine: 1, endLine: 100 },
      });

      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);
      expect(result.nodesAdded).toBe(1);

      const usesEdges = graph.relationships.filter(r => r.type === 'USES' && r.reason === 'blueprint-component');
      expect(usesEdges.length).toBe(3);
      expect(usesEdges[0].confidence).toBe(0.95);
    });

    it('deduplicates USES edges for same component class', async () => {
      await writeManifest([
        {
          asset_path: '/Game/BP_Room',
          components: [
            { name: 'Light1', component_class: 'PointLightComponent' },
            { name: 'Light2', component_class: 'PointLightComponent' },
          ],
        },
      ]);

      graph.addNode({
        id: 'class-pointlight',
        label: 'Class',
        properties: { name: 'PointLightComponent', filePath: 'PointLight.h', startLine: 1, endLine: 50 },
      });

      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);
      const usesEdges = graph.relationships.filter(r => r.type === 'USES' && r.reason === 'blueprint-component');
      // Only one edge despite two instances of the same class
      expect(usesEdges.length).toBe(1);
    });

    it('skips components with class None', async () => {
      await writeManifest([
        {
          asset_path: '/Game/BP_Test',
          components: [
            { name: 'BadComp', component_class: 'None' },
          ],
        },
      ]);

      await ingestBlueprintsIntoGraph(graph, tmpDir);
      const usesEdges = graph.relationships.filter(r => r.type === 'USES');
      expect(usesEdges.length).toBe(0);
    });
  });

  describe('AnimBP state machine Process nodes', () => {
    it('creates Process node for state machine with CONTAINS edge', async () => {
      await writeManifest([
        {
          asset_path: '/Game/Anim/ABP_Hero',
          asset_class: '/Script/Engine.AnimBlueprint',
          native_parents: ['UAnimInstance'],
          state_machines: [
            {
              name: 'Locomotion',
              states: [
                { name: 'Idle', graph_name: 'Idle_Graph' },
                { name: 'Run', graph_name: 'Run_Graph' },
                { name: 'Jump', graph_name: 'Jump_Graph' },
              ],
              transitions: [
                { from_state: 'Idle', to_state: 'Run' },
                { from_state: 'Run', to_state: 'Idle' },
                { from_state: 'Run', to_state: 'Jump' },
              ],
            },
          ],
        },
      ]);

      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);

      // 1 AnimBlueprint node + 1 Process node for the state machine
      expect(result.nodesAdded).toBe(2);

      // Find the Process node
      const processNode = graph.nodes.find(n => n.label === 'Process' && n.properties.processType === 'state_machine');
      expect(processNode).toBeDefined();
      expect(processNode!.properties.name).toBe('ABP_Hero::Locomotion');
      expect(processNode!.properties.stepCount).toBe(3);

      // CONTAINS edge from AnimBlueprint to Process
      const containsEdges = graph.relationships.filter(
        r => r.type === 'CONTAINS' && r.reason === 'animblueprint-state-machine'
      );
      expect(containsEdges.length).toBe(1);

      // STEP_IN_PROCESS edges — one per state
      const stepEdges = graph.relationships.filter(
        r => r.type === 'STEP_IN_PROCESS' && r.reason === 'animblueprint-state'
      );
      expect(stepEdges.length).toBe(3);
    });

    it('skips state machine with no states', async () => {
      await writeManifest([
        {
          asset_path: '/Game/Anim/ABP_Empty',
          asset_class: '/Script/Engine.AnimBlueprint',
          state_machines: [
            { name: 'EmptySM', states: [], transitions: [] },
          ],
        },
      ]);

      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);
      // Only the AnimBlueprint node, no Process
      expect(result.nodesAdded).toBe(1);
    });
  });

  describe('Blueprint variable RepNotify CALLS edges', () => {
    it('creates CALLS edge for replicated variable with RepNotify', async () => {
      await writeManifest([
        {
          asset_path: '/Game/BP_Hero',
          native_parents: ['ACharacter'],
          variables: [
            { name: 'Health', type: 'real', replicated: true, rep_notify: true, rep_notify_func: 'OnRep_Health' },
            { name: 'Speed', type: 'real' },
            { name: 'Inventory', type: 'object', container: 'array', save_game: true },
          ],
        },
      ]);

      // Add C++ class and rep notify method
      graph.addNode({
        id: 'class-acharacter',
        label: 'Class',
        properties: { name: 'ACharacter', filePath: 'Character.h', startLine: 1, endLine: 100 },
      });
      graph.addNode({
        id: 'method-onrep-health',
        label: 'Method',
        properties: { name: 'OnRep_Health', filePath: 'Character.cpp', startLine: 50, endLine: 60 },
      });

      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);

      const repNotifyEdges = graph.relationships.filter(
        r => r.type === 'CALLS' && r.reason === 'blueprint-rep-notify'
      );
      expect(repNotifyEdges.length).toBe(1);
      expect(repNotifyEdges[0].confidence).toBe(1.0);

      const target = graph.getNode(repNotifyEdges[0].targetId);
      expect(target?.properties.name).toBe('OnRep_Health');
    });

    it('does not create CALLS edge for non-replicated variables', async () => {
      await writeManifest([
        {
          asset_path: '/Game/BP_Simple',
          variables: [
            { name: 'Score', type: 'int' },
            { name: 'Name', type: 'string' },
          ],
        },
      ]);

      await ingestBlueprintsIntoGraph(graph, tmpDir);
      const repNotifyEdges = graph.relationships.filter(
        r => r.type === 'CALLS' && r.reason === 'blueprint-rep-notify'
      );
      expect(repNotifyEdges.length).toBe(0);
    });
  });

  describe('BehaviorTree CALLS edges and Process nodes', () => {
    it('creates CALLS edges for BT task classes and Process node', async () => {
      await writeManifest([
        {
          asset_path: '/Game/AI/BT_Patrol',
          asset_class: '/Script/AIModule.BehaviorTree',
          bt_nodes: [
            { node_class: 'BTComposite_Sequence', node_name: 'Sequence', type: 'composite', depth: 0 },
            { node_class: 'BTTask_MoveTo', node_name: 'Move To', type: 'task', depth: 1, parent_index: 0 },
            { node_class: 'BTTask_Wait', node_name: 'Wait', type: 'task', depth: 1, parent_index: 0 },
            { node_class: 'BTDecorator_Blackboard', node_name: 'Blackboard', type: 'decorator', depth: 1, attached_to: 0 },
            { node_class: 'BTService_DefaultFocus', node_name: 'Focus', type: 'service', depth: 0, attached_to: 0 },
          ],
        },
      ]);

      // Add C++ class nodes for BT tasks
      graph.addNode({
        id: 'class-btmoveto',
        label: 'Class',
        properties: { name: 'BTTask_MoveTo', filePath: 'BTTask_MoveTo.h', startLine: 1, endLine: 50 },
      });
      graph.addNode({
        id: 'class-btdecorator',
        label: 'Class',
        properties: { name: 'BTDecorator_Blackboard', filePath: 'BTDecorator_Blackboard.h', startLine: 1, endLine: 50 },
      });

      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);

      // BehaviorTree node + Process node
      expect(result.nodesAdded).toBe(2);

      // Process node
      const processNode = graph.nodes.find(n => n.label === 'Process' && n.properties.processType === 'behavior_tree');
      expect(processNode).toBeDefined();
      expect(processNode!.properties.name).toBe('BT_Patrol::Root');

      // CALLS edges for matched C++ classes
      const btCallEdges = graph.relationships.filter(r =>
        r.type === 'CALLS' && (r.reason === 'behaviortree-task' || r.reason === 'behaviortree-decorator')
      );
      expect(btCallEdges.length).toBe(2);

      // CONTAINS edge
      const containsEdges = graph.relationships.filter(r =>
        r.type === 'CONTAINS' && r.reason === 'behaviortree-root'
      );
      expect(containsEdges.length).toBe(1);
    });
  });

  describe('EQS CALLS edges', () => {
    it('creates CALLS edges for EQS generator and test classes', async () => {
      await writeManifest([
        {
          asset_path: '/Game/AI/EQS_FindCover',
          asset_class: '/Script/AIModule.EnvironmentQuery',
          eqs_options: [
            {
              generator_class: 'EnvQueryGenerator_SimpleGrid',
              generator_name: 'Simple Grid',
              item_type: 'EnvQueryItemType_Point',
              tests: [
                { class: 'EnvQueryTest_Distance', name: 'Distance' },
                { class: 'EnvQueryTest_Trace', name: 'Trace' },
              ],
            },
          ],
        },
      ]);

      graph.addNode({
        id: 'class-eqsgrid',
        label: 'Class',
        properties: { name: 'EnvQueryGenerator_SimpleGrid', filePath: 'EQS.h', startLine: 1, endLine: 50 },
      });
      graph.addNode({
        id: 'class-eqsdist',
        label: 'Class',
        properties: { name: 'EnvQueryTest_Distance', filePath: 'EQS.h', startLine: 51, endLine: 100 },
      });

      const result = await ingestBlueprintsIntoGraph(graph, tmpDir);

      const eqsCallEdges = graph.relationships.filter(r =>
        r.type === 'CALLS' && (r.reason === 'eqs-generator' || r.reason === 'eqs-test')
      );
      // Generator + Distance test = 2 matched classes
      expect(eqsCallEdges.length).toBe(2);
    });
  });
});
