/**
 * Pure helpers for bounding a Figma document node tree before it reaches the
 * LLM. A single Figma file serialises to 5+ MB; `figma.get_file` and
 * `figma.get_file_nodes` prune the tree to a caller-supplied node budget so a
 * surgical read never floods the context.
 *
 * Zero I/O — trivial to unit-test for depth / budget edge cases.
 */

/** Guard against pathological / cyclic-looking trees. */
const MAX_DEPTH = 50;

interface NodeLike {
  readonly children?: readonly unknown[];
}

function asNode(value: unknown): (Record<string, unknown> & NodeLike) | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown> & NodeLike) : undefined;
}

/** Total node count across a forest of Figma nodes (depth-capped). */
export function countNodes(children: readonly unknown[], depth = 0): number {
  if (depth > MAX_DEPTH) return 0;
  let total = children.length;
  for (const child of children) {
    const node = asNode(child);
    if (node && Array.isArray(node.children)) {
      total += countNodes(node.children, depth + 1);
    }
  }
  return total;
}

/** Result of {@link pruneNodeTree}. */
export interface PrunedForest {
  /** The pruned forest — at most `maxNodes` nodes, original DFS order preserved. */
  readonly children: readonly unknown[];
  /** Total node count in the *original* forest (before pruning). */
  readonly totalNodes: number;
  /** `true` when the original forest exceeded `maxNodes` and was clipped. */
  readonly truncated: boolean;
}

/**
 * Prune a Figma node forest to at most `maxNodes` nodes, depth-first. Nodes
 * keep all of their own properties; only descendants beyond the budget are
 * dropped. A node whose children were (partly) cut gains
 * `childrenTruncated: true`. Returns the input untouched when it already fits.
 */
export function pruneNodeTree(children: readonly unknown[], maxNodes: number): PrunedForest {
  const cap = Math.max(1, Math.floor(maxNodes));
  const totalNodes = countNodes(children);
  if (totalNodes <= cap) {
    return { children, totalNodes, truncated: false };
  }
  const budget = { left: cap };
  return { children: pruneForest(children, budget, 0), totalNodes, truncated: true };
}

function pruneForest(nodes: readonly unknown[], budget: { left: number }, depth: number): unknown[] {
  const out: unknown[] = [];
  for (const value of nodes) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    const node = asNode(value);
    if (depth >= MAX_DEPTH || !node || !Array.isArray(node.children) || node.children.length === 0) {
      out.push(value);
      continue;
    }
    const originalCount = node.children.length;
    const prunedChildren = budget.left > 0 ? pruneForest(node.children, budget, depth + 1) : [];
    out.push(rebuildNode(node, prunedChildren, prunedChildren.length < originalCount));
  }
  return out;
}

/** Clone a node, replacing `children` with the pruned set and flagging cuts. */
function rebuildNode(
  node: Record<string, unknown>,
  prunedChildren: readonly unknown[],
  cut: boolean,
): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node)) {
    if (key !== 'children') rest[key] = val;
  }
  if (prunedChildren.length > 0) rest['children'] = prunedChildren;
  if (cut) rest['childrenTruncated'] = true;
  return rest;
}
