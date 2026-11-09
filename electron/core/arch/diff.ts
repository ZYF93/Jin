import { canonicalize } from "../hash/canonical";
import type {
  ArchDiff,
  ChangeKind,
  EdgeChange,
  NodeChange,
  RiskHint,
} from "../../../shared/arch/diff";
import type { ArchEdge, ArchNode, ArchSnapshot } from "../../../shared/ledger/types";

const NODE_FIELDS: ReadonlyArray<keyof ArchNode> = [
  "level",
  "kind",
  "parentId",
  "name",
  "path",
  "file",
  "symbol",
  "responsibility",
  "status",
  "metadata",
];

const EDGE_FIELDS: ReadonlyArray<keyof ArchEdge> = [
  "from",
  "to",
  "kind",
  "metadata",
];

function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: ReadonlyArray<keyof T>,
): string[] {
  return fields
    .filter((field) => canonicalize(before[field]) !== canonicalize(after[field]))
    .map(String);
}

function nodeChange(
  before: ArchNode | null,
  after: ArchNode | null,
): NodeChange | null {
  if (!before && !after) return null;
  if (!before && after) {
    return {
      id: after.id,
      change: "added",
      before: null,
      after,
      fields: [],
      propagated: false,
    };
  }
  if (before && !after) {
    return {
      id: before.id,
      change: "removed",
      before,
      after: null,
      fields: [],
      propagated: false,
    };
  }
  if (!before || !after) return null;
  const fields = changedFields(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
    NODE_FIELDS,
  );
  if (fields.length === 0) return null;
  return {
    id: before.id,
    change: "modified",
    before,
    after,
    fields,
    propagated: false,
  };
}

function edgeChange(
  before: ArchEdge | null,
  after: ArchEdge | null,
): EdgeChange | null {
  if (!before && !after) return null;
  if (!before && after) {
    return {
      id: after.id,
      change: "added",
      before: null,
      after,
      fields: [],
    };
  }
  if (before && !after) {
    return {
      id: before.id,
      change: "removed",
      before,
      after: null,
      fields: [],
    };
  }
  if (!before || !after) return null;
  const fields = changedFields(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
    EDGE_FIELDS,
  );
  if (fields.length === 0) return null;
  return {
    id: before.id,
    change: "modified",
    before,
    after,
    fields,
  };
}

function setColor(
  colors: Map<string, ChangeKind>,
  id: string,
  change: ChangeKind,
): void {
  const current = colors.get(id);
  if (!current) {
    colors.set(id, change);
    return;
  }
  // A direct addition/removal is stronger than a propagated modification.
  if (current === "modified" && change !== "modified") colors.set(id, change);
}

function propagate(
  colors: Map<string, ChangeKind>,
  nodes: Record<string, ArchNode>,
  id: string,
): void {
  let current = nodes[id];
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    setColor(colors, current.parentId, "modified");
    current = nodes[current.parentId];
  }
}

/**
 * Compare two snapshots. Only direct node/edge changes live in `nodes`/`edges`;
 * `colors` additionally contains the ancestors and edge endpoints that should
 * be tinted in the architecture graph.
 */
export function diffSnapshots(
  before: ArchSnapshot,
  after: ArchSnapshot,
): ArchDiff {
  const nodes: Record<string, NodeChange> = {};
  const edges: Record<string, EdgeChange> = {};
  const colors = new Map<string, ChangeKind>();

  const nodeIds = new Set([
    ...Object.keys(before.nodes),
    ...Object.keys(after.nodes),
  ]);
  for (const id of nodeIds) {
    const change = nodeChange(before.nodes[id] ?? null, after.nodes[id] ?? null);
    if (!change) continue;
    nodes[id] = change;
    setColor(colors, id, change.change);
  }

  const edgeIds = new Set([
    ...Object.keys(before.edges),
    ...Object.keys(after.edges),
  ]);
  for (const id of edgeIds) {
    const change = edgeChange(before.edges[id] ?? null, after.edges[id] ?? null);
    if (!change) continue;
    edges[id] = change;
    const fromId = change.after?.from ?? change.before?.from;
    const toId = change.after?.to ?? change.before?.to;
    if (fromId && (before.nodes[fromId] || after.nodes[fromId])) {
      setColor(colors, fromId, "modified");
    }
    if (toId && (before.nodes[toId] || after.nodes[toId])) {
      setColor(colors, toId, "modified");
    }
  }

  // Propagate after all direct colors are known, so a newly added parent is not
  // downgraded to yellow by one of its children.
  for (const change of Object.values(nodes)) {
    if (change.before) propagate(colors, before.nodes, change.id);
    if (change.after) propagate(colors, after.nodes, change.id);
  }
  for (const change of Object.values(edges)) {
    for (const [snapshot, side] of [
      [before, change.before],
      [after, change.after],
    ] as const) {
      if (!side) continue;
      if (snapshot.nodes[side.from]) {
        propagate(colors, snapshot.nodes, side.from);
      }
      if (snapshot.nodes[side.to]) {
        propagate(colors, snapshot.nodes, side.to);
      }
    }
  }

  const direct = Object.values(nodes);
  const summary = {
    added: direct.filter((node) => node.change === "added").length,
    removed: direct.filter((node) => node.change === "removed").length,
    modified: direct.filter((node) => node.change === "modified").length,
    affected: colors.size,
  };

  return {
    nodes,
    edges,
    colors: Object.fromEntries(colors),
    summary,
  };
}

function hasNode(
  diff: ArchDiff,
  predicate: (node: ArchNode) => boolean,
): boolean {
  return Object.values(diff.nodes).some((change) => {
    if (change.change === "removed") return predicate(change.before as ArchNode);
    return predicate((change.after ?? change.before) as ArchNode);
  });
}

/**
 * Human-readable risks for the approval card. Keep these architectural, not
 * stylistic: removals, cross-module moves, missing responsibilities, and broad
 * blast radius are the things a reviewer must notice before approving.
 */
export function riskHints(before: ArchSnapshot, _after: ArchSnapshot, diff: ArchDiff): RiskHint[] {
  const risks: RiskHint[] = [];
  const total = diff.summary.added + diff.summary.removed + diff.summary.modified;

  if (diff.summary.removed > 0) {
    risks.push({
      id: "risk:removals",
      level: "high",
      title: `${diff.summary.removed} node${diff.summary.removed === 1 ? "" : "s"} removed`,
      detail:
        "Removing architecture nodes also removes their containment/dependency edges. Verify that the code and its consumers are being retired together.",
    });
  }

  const systemChanged = hasNode(
    diff,
    (node) => node.level === "L0" && node.kind === "system",
  );
  if (systemChanged) {
    risks.push({
      id: "risk:system",
      level: "high",
      title: "System boundary changed",
      detail: "The root system node is part of every dependency path. Review module ownership before approving.",
    });
  }

  const moved = Object.values(diff.nodes).some(
    (change) =>
      change.change === "modified" &&
      change.fields.includes("parentId") &&
      change.before?.parentId !== change.after?.parentId,
  );
  if (moved) {
    risks.push({
      id: "risk:moves",
      level: "high",
      title: "An L1 owner changed",
      detail: "A node is being moved to a different L0 module. This changes ownership, not just the file tree.",
    });
  }

  if (total > 15 || diff.summary.affected > 30) {
    risks.push({
      id: "risk:blast-radius",
      level: "high",
      title: "Broad architecture blast radius",
      detail: `${total} direct changes affect ${diff.summary.affected} nodes. Consider splitting this into smaller approved versions.`,
    });
  } else if (total > 7 || diff.summary.affected > 15) {
    risks.push({
      id: "risk:blast-radius-medium",
      level: "medium",
      title: "Multiple modules affected",
      detail: `${total} direct changes affect ${diff.summary.affected} nodes across the graph.`,
    });
  }

  const unowned = Object.values(diff.nodes).filter((change) => {
    const node = change.after ?? change.before;
    return node?.level === "L1" && !node.responsibility.trim();
  });
  if (unowned.length > 0) {
    risks.push({
      id: "risk:responsibility",
      level: "medium",
      title: "L1 responsibilities are missing",
      detail: `${unowned.length} changed L1 node${unowned.length === 1 ? "" : "s"} have no responsibility statement. Intent will be harder to verify later.`,
    });
  }

  const removedWithChildren = Object.values(diff.nodes).some(
    (change) =>
      change.change === "removed" &&
      Object.values(before.nodes).some((node) => node.parentId === change.id),
  );
  if (removedWithChildren) {
    risks.push({
      id: "risk:remove-children",
      level: "high",
      title: "Removed a node with children",
      detail: "The snapshot removes their edges too. Check the L1 descendants before approving.",
    });
  }

  if (risks.length === 0) {
    risks.push({
      id: "risk:contained",
      level: "low",
      title: "Contained change",
      detail: "No system boundary, removals, or broad cross-module blast radius detected.",
    });
  }

  const priority: Record<RiskHint["level"], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  return risks.sort((a, b) => priority[a.level] - priority[b.level]);
}
