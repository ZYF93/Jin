import type {
  ArchEdge,
  ArchNode,
  ArchOp,
  ArchSnapshot,
} from "../../../shared/ledger/types";
import { hashValue } from "../hash/canonical";
import { applyOp, hashEdgeForWrite, hashNodeForWrite } from "../arch/snapshot";

/** A conflicted version reconstructed from its own WAL ancestry. */
export interface MergeSource {
  versionId: string;
  base: ArchSnapshot;
  target: ArchSnapshot;
}

export interface MergePlan {
  ops: ArchOp[];
  notes: string[];
}

type NodePatch = Extract<ArchOp, { op: "node.update" }>["patch"];

const NODE_FIELDS = [
  "level",
  "kind",
  "parentId",
  "name",
  "path",
  "file",
  "symbol",
  "responsibility",
  "status",
] as const;

function same(left: unknown, right: unknown): boolean {
  return hashValue(left) === hashValue(right);
}

function draftNode(node: ArchNode): Omit<
  ArchNode,
  "introducedIn" | "updatedIn" | "lastTouchedIn"
> {
  return {
    id: node.id,
    level: node.level,
    kind: node.kind,
    parentId: node.parentId,
    name: node.name,
    path: node.path,
    file: node.file,
    symbol: node.symbol,
    responsibility: node.responsibility,
    intentId: node.intentId,
    status: node.status,
    metadata: { ...node.metadata },
  };
}

function draftEdge(edge: ArchEdge): Omit<ArchEdge, "introducedIn"> {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    metadata: { ...edge.metadata },
  };
}

function mergeMetadata(
  base: Record<string, unknown>,
  target: Record<string, unknown>,
  live: Record<string, unknown>,
  label: string,
  notes: string[],
): Record<string, unknown> | null {
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    const before = base[key];
    const next = target[key];
    const current = live[key];
    if (same(before, next)) continue;
    if (same(current, before) || same(current, next)) {
      patch[key] = next;
      continue;
    }
    notes.push(`${label}: both branches changed metadata.${key}; kept the current value.`);
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Three-way merge of the branch targets that the fold had to skip. Only fields
 * a branch actually changed relative to its own base are carried over, so
 * applying one branch's target never silently reverts the other branch.
 */
export function planMerge(
  live: ArchSnapshot,
  sources: readonly MergeSource[],
): MergePlan {
  const working = {
    ...live,
    nodes: { ...live.nodes },
    edges: { ...live.edges },
  };
  const ops: ArchOp[] = [];
  const notes: string[] = [];

  const advance = (op: ArchOp): void => {
    const conflict = applyOp(working, op, "merge");
    if (conflict) {
      throw new Error(`Merge plan produced an invalid op: ${conflict.message}`);
    }
    ops.push(op);
  };

  for (const source of sources) {
    const nodeIds = new Set([
      ...Object.keys(source.base.nodes),
      ...Object.keys(source.target.nodes),
      ...Object.keys(working.nodes),
    ]);
    for (const id of nodeIds) {
      const before = source.base.nodes[id];
      const target = source.target.nodes[id];
      const current = working.nodes[id];

      if (!before && target) {
        if (!current) {
          advance({ op: "node.add", node: draftNode(target) });
        } else if (!same(hashNodeForWrite(current), hashNodeForWrite(target))) {
          notes.push(`Node ${target.name || id}: both branches added it differently; kept the current node.`);
        }
        continue;
      }

      if (before && !target) {
        if (!current) continue;
        if (same(hashNodeForWrite(current), hashNodeForWrite(before))) {
          advance({ op: "node.remove", id, beforeHash: hashNodeForWrite(current) });
        } else {
          notes.push(
            `Node ${before.name || id}: one branch removed it while the other changed it; kept the current node.`,
          );
        }
        continue;
      }

      if (!before || !target || !current) continue;
      if (same(hashNodeForWrite(target), hashNodeForWrite(before))) continue;
      if (same(hashNodeForWrite(current), hashNodeForWrite(target))) continue;

      const patch: NodePatch = {};
      for (const field of NODE_FIELDS) {
        if (same(target[field], before[field])) continue;
        if (same(current[field], before[field]) || same(current[field], target[field])) {
          (patch as Record<string, unknown>)[field] = target[field];
          continue;
        }
        notes.push(
          `Node ${target.name || id}: both branches changed ${field}; kept the current value.`,
        );
      }

      const metadata = mergeMetadata(
        before.metadata,
        target.metadata,
        current.metadata,
        `Node ${target.name || id}`,
        notes,
      );
      if (metadata) patch.metadata = metadata;

      if (Object.keys(patch).length > 0) {
        advance({
          op: "node.update",
          id,
          patch,
          beforeHash: hashNodeForWrite(current),
        });
      }
    }

    const edgeIds = new Set([
      ...Object.keys(source.base.edges),
      ...Object.keys(source.target.edges),
      ...Object.keys(working.edges),
    ]);
    for (const id of edgeIds) {
      const before = source.base.edges[id];
      const target = source.target.edges[id];
      const current = working.edges[id];

      if (!before && target) {
        if (!current) {
          advance({ op: "edge.add", edge: draftEdge(target) });
        } else if (!same(hashEdgeForWrite(current), hashEdgeForWrite(target))) {
          notes.push(`Edge ${id}: both branches added it differently; kept the current edge.`);
        }
        continue;
      }

      if (before && !target) {
        if (!current) continue;
        if (same(hashEdgeForWrite(current), hashEdgeForWrite(before))) {
          advance({ op: "edge.remove", id, beforeHash: hashEdgeForWrite(current) });
        } else {
          notes.push(
            `Edge ${id}: one branch removed it while the other changed it; kept the current edge.`,
          );
        }
        continue;
      }

      if (!before || !target || !current) continue;
      if (same(hashEdgeForWrite(target), hashEdgeForWrite(before))) continue;
      if (same(hashEdgeForWrite(current), hashEdgeForWrite(target))) continue;
      notes.push(`Edge ${id}: both branches changed it; kept the current edge.`);
    }
  }

  return { ops, notes };
}

/** Conflicts that mean the ledger itself is malformed, not just divergent. */
export const FATAL_WAL_CONFLICTS = new Set([
  "duplicate-id",
  "missing-parent",
  "cycle",
  "missing-intent",
]);
