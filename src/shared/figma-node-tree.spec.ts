/**
 * Unit tests — countNodes / pruneNodeTree (pure helpers for `figma.get_file`
 * and `figma.get_file_nodes`).
 */
import { describe, expect, it } from 'vitest';

import { countNodes, pruneNodeTree } from './figma-node-tree.js';

interface TestNode {
  readonly id: string;
  readonly name?: string;
  readonly children?: readonly TestNode[];
  readonly childrenTruncated?: boolean;
}

const ids = (forest: readonly unknown[]): string[] => forest.map((n) => (n as TestNode).id);

describe('countNodes', () => {
  it('counts a flat forest', () => {
    expect(countNodes([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(3);
  });

  it('counts nested children', () => {
    const forest = [{ id: 'root', children: [{ id: 'c1' }, { id: 'c2' }] }, { id: 'b' }];
    expect(countNodes(forest)).toBe(4); // root + c1 + c2 + b
  });

  it('ignores non-object entries', () => {
    expect(countNodes([null, 'x', 42, { id: 'a' }])).toBe(4);
  });
});

describe('pruneNodeTree', () => {
  it('returns the forest untouched when it fits the budget', () => {
    const forest = [{ id: 'a' }, { id: 'b', children: [{ id: 'c' }] }];
    const result = pruneNodeTree(forest, 10);
    expect(result.truncated).toBe(false);
    expect(result.totalNodes).toBe(3);
    expect(result.children).toBe(forest); // same reference, no copy
  });

  it('prunes a deep child list to the budget and flags the cut', () => {
    const forest = [{ id: 'root', children: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] }];
    const result = pruneNodeTree(forest, 2);
    expect(result.truncated).toBe(true);
    expect(result.totalNodes).toBe(4);
    expect(countNodes(result.children)).toBeLessThanOrEqual(2);
    const root = result.children[0] as TestNode;
    expect(root.id).toBe('root');
    expect(root.children).toHaveLength(1);
    expect(root.childrenTruncated).toBe(true);
  });

  it('drops overflow roots while preserving order and properties', () => {
    const forest = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ];
    const result = pruneNodeTree(forest, 2);
    expect(result.truncated).toBe(true);
    expect(ids(result.children)).toEqual(['a', 'b']);
    expect((result.children[0] as TestNode).name).toBe('A');
  });

  it('does not mutate the input forest', () => {
    const root = { id: 'root', children: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] };
    pruneNodeTree([root], 2);
    expect(root.children).toHaveLength(3); // original intact
  });
});
