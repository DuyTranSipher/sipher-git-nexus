/**
 * Gameplay Tag parsing and hierarchy construction.
 * Reads DefaultGameplayTags.ini and builds a tag tree for the knowledge graph.
 */

import fs from 'fs/promises';
import path from 'path';
import { KnowledgeGraph } from '../core/graph/types.js';
import { generateId } from '../lib/utils.js';

interface GameplayTagTree {
  /** All unique tags found */
  tags: Set<string>;
  /** Parent->children relationships (tag string -> child tag strings) */
  children: Map<string, string[]>;
}

/**
 * Parse Gameplay Tags from project config files.
 * Reads DefaultGameplayTags.ini looking for lines like:
 *   +GameplayTagList=(Tag="Ability.Attack.Melee",DevComment="")
 */
export async function parseGameplayTags(projectPath: string): Promise<GameplayTagTree> {
  const tags = new Set<string>();
  const children = new Map<string, string[]>();

  // Look for tag config files
  const configPaths = [
    path.join(projectPath, 'Config', 'DefaultGameplayTags.ini'),
    path.join(projectPath, 'Config', 'Tags', 'DefaultGameplayTags.ini'),
  ];

  for (const configPath of configPaths) {
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      // Extract tags from lines like: +GameplayTagList=(Tag="Ability.Attack.Melee",DevComment="")
      const tagPattern = /Tag="([^"]+)"/g;
      let match;
      while ((match = tagPattern.exec(content)) !== null) {
        const tag = match[1];
        tags.add(tag);
        // Also add all parent segments
        const parts = tag.split('.');
        for (let i = 1; i < parts.length; i++) {
          const parentTag = parts.slice(0, i).join('.');
          tags.add(parentTag);
        }
      }
    } catch { /* file not found, skip */ }
  }

  // Build parent->children hierarchy
  for (const tag of tags) {
    const dotIdx = tag.lastIndexOf('.');
    if (dotIdx >= 0) {
      const parent = tag.slice(0, dotIdx);
      let childList = children.get(parent);
      if (!childList) { childList = []; children.set(parent, childList); }
      childList.push(tag);
    }
  }

  return { tags, children };
}

/**
 * Ingest GameplayTag nodes and PARENT_TAG edges into the knowledge graph.
 * Returns the number of nodes and edges added.
 */
export function ingestGameplayTagsIntoGraph(
  graph: KnowledgeGraph,
  tagTree: GameplayTagTree,
): { nodesAdded: number; edgesAdded: number } {
  let nodesAdded = 0;
  let edgesAdded = 0;

  // Create GameplayTag nodes
  for (const tag of tagTree.tags) {
    const nodeId = generateId('GameplayTag', tag);
    graph.addNode({
      id: nodeId,
      label: 'GameplayTag',
      properties: {
        name: tag,
        filePath: `GameplayTag:${tag}`,
        startLine: -1,
        endLine: -1,
      },
    });
    nodesAdded++;
  }

  // Create PARENT_TAG edges
  for (const [parent, childTags] of tagTree.children) {
    const parentId = generateId('GameplayTag', parent);
    for (const child of childTags) {
      const childId = generateId('GameplayTag', child);
      graph.addRelationship({
        id: generateId('PARENT_TAG', `${parentId}->${childId}`),
        sourceId: parentId,
        targetId: childId,
        type: 'PARENT_TAG',
        confidence: 1.0,
        reason: 'gameplay-tag-hierarchy',
      });
      edgesAdded++;
    }
  }

  return { nodesAdded, edgesAdded };
}
