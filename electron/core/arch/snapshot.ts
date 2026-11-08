import { hashValue } from "../hash/canonical";
import type {
  ArchEdge,
  ArchNode,
  ArchOp,
  ArchSnapshot,
  Decision,
  ImplementationRecord,
  Intent,
  Touch,
  VersionState,
  WalConflict,
} from "../../../shared/arch/types";
import type { WalRecord } from "../../../shared/wal/types";

export function emptySnapshot(): ArchSnapshot {
  return {
    schemaVersion: 1,
    nodes: {},
    edges: {},
    intents: {},
    touches: {},
    versions: {},
    decisions: {},
    implementations: {},
    lastRecordId: null,
    recordCount: 0,
  };
}

export function cloneSnapshot(snapshot: ArchSnapshot): ArchSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ArchSnapshot;
}

/**
 * Semantic snapshot hash. Timestamps and touch bookkeeping are excluded so a
 * touch-only version has the same base and target; the reviewed change set is
 * bound separately with `diffHash`.
 */
export function hashSnapshot(snapshot: ArchSnapshot): string {
  const nodes = Object.values(snapshot.nodes)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((node) => semanticNode(node));
  const edges = Object.values(snapshot.edges)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((edge) => semanticEdge(edge));
  return hashValue({ nodes, edges });
}

function semanticNode(node: ArchNode): Record<string, unknown> {
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
    metadata: node.metadata,
  };
}

function semanticEdge(edge: ArchEdge): Record<string, unknown> {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    metadata: edge.metadata,
  };
}

/**
 * Optimistic-concurrency hash for structural writes. Touch bookkeeping is
 * excluded: a code-only touch must not invalidate a pending structural update.
 */
export function hashNodeForWrite(node: ArchNode): string {
  return hashValue(semanticNode(node));
}

export function hashEdgeForWrite(edge: ArchEdge): string {
  return hashValue(semanticEdge(edge));
}

function sortByHlcThenId(
  a: WalRecord,
  b: WalRecord,
): number {
  if (a.hlc === b.hlc) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.hlc < b.hlc ? -1 : 1;
}

/**
 * Hash the reviewed change set itself. This is the approval binding: it does
 * not include the global base/target snapshot, so two disjoint concurrent
 * approvals can merge without invalidating each other.
 *
 * Payload order is significant for an unsealed proposal. When records are
 * written, the session creates them in this order, so the HLC-sorted fold
 * reproduces the same sequence.
 */
export function diffHashForChanges(
  intent: Intent,
  ops: readonly ArchOp[],
  touches: readonly Touch[] = [],
): string {
  const nodeIntents = [...intent.nodeIntents].sort((a, b) => {
    const left = `${a.nodeId}:${a.facetId ?? ""}:${a.statement}`;
    const right = `${b.nodeId}:${b.facetId ?? ""}:${b.statement}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return hashValue({
    intent: {
      title: intent.title,
      goal: intent.goal,
      tasks: intent.tasks,
      nodeIntents,
    },
    ops,
    touches,
  });
}

/** Hash the approved change set from sealed WAL records. */
export function diffHashForVersion(
  intent: Intent,
  ops: readonly WalRecord[],
  touches: readonly WalRecord[],
): string {
  const orderedOps = [...ops]
    .sort(sortByHlcThenId)
    .map((record) => record.payload as ArchOp);
  const orderedTouches = [...touches]
    .sort(sortByHlcThenId)
    .map((record) => record.payload as Touch);
  return diffHashForChanges(intent, orderedOps, orderedTouches);
}

function conflict(
  code: WalConflict["code"],
  message: string,
  recordId: string,
  nodeId?: string,
): WalConflict {
  const result: WalConflict = {
    code,
    message,
    recordIds: recordId ? [recordId] : [],
  };
  if (nodeId) result.nodeId = nodeId;
  return result;
}

/**
 * Apply one structural op to a snapshot. The snapshot is mutated only when the
 * op is conflict-free; callers that need atomicity should pass a clone.
 */
export function applyOp(
  snapshot: ArchSnapshot,
  op: ArchOp,
  versionId: string,
  recordId = "",
): WalConflict | null {
  if (op.op === "node.add") {
    if (snapshot.nodes[op.node.id]) {
      return conflict(
        "stale-write",
        `Cannot add node ${op.node.id}: it already exists`,
        recordId,
        op.node.id,
      );
    }
    const node: ArchNode = {
      ...op.node,
      introducedIn: versionId,
      updatedIn: versionId,
      lastTouchedIn: null,
      metadata: { ...op.node.metadata },
    };
    snapshot.nodes[node.id] = node;
    return null;
  }

  if (op.op === "node.update") {
    const node = snapshot.nodes[op.id];
    if (!node) {
      return conflict("missing-node", `Cannot update missing node ${op.id}`, recordId, op.id);
    }
    if (hashNodeForWrite(node) !== op.beforeHash) {
      return conflict(
        "stale-write",
        `Node ${op.id} changed since this op was proposed`,
        recordId,
        op.id,
      );
    }
    const metadata = op.patch.metadata
      ? { ...node.metadata, ...op.patch.metadata }
      : node.metadata;
    snapshot.nodes[op.id] = {
      ...node,
      ...op.patch,
      metadata,
      updatedIn: versionId,
    };
    return null;
  }

  if (op.op === "node.remove") {
    const node = snapshot.nodes[op.id];
    if (!node) {
      return conflict("missing-node", `Cannot remove missing node ${op.id}`, recordId, op.id);
    }
    if (hashNodeForWrite(node) !== op.beforeHash) {
      return conflict(
        "stale-write",
        `Node ${op.id} changed since this removal was proposed`,
        recordId,
        op.id,
      );
    }
    delete snapshot.nodes[op.id];
    for (const [edgeId, edge] of Object.entries(snapshot.edges)) {
      if (edge.from === op.id || edge.to === op.id) delete snapshot.edges[edgeId];
    }
    return null;
  }

  if (op.op === "edge.add") {
    const existing = snapshot.edges[op.edge.id];
    if (existing) {
      const same =
        existing.from === op.edge.from &&
        existing.to === op.edge.to &&
        existing.kind === op.edge.kind &&
        hashValue(existing.metadata) === hashValue(op.edge.metadata);
      if (same) return null;
      return conflict(
        "stale-write",
        `Edge ${op.edge.id} already exists with different content`,
        recordId,
        op.edge.id,
      );
    }
    const edge: ArchEdge = {
      ...op.edge,
      introducedIn: versionId,
      metadata: { ...op.edge.metadata },
    };
    snapshot.edges[edge.id] = edge;
    return null;
  }

  if (op.op === "edge.remove") {
    const edge = snapshot.edges[op.id];
    if (!edge) {
      return conflict("missing-edge", `Cannot remove missing edge ${op.id}`, recordId, op.id);
    }
    if (hashEdgeForWrite(edge) !== op.beforeHash) {
      return conflict(
        "stale-write",
        `Edge ${op.id} changed since this removal was proposed`,
        recordId,
        op.id,
      );
    }
    delete snapshot.edges[op.id];
    return null;
  }

  const exhaustive: never = op;
  return conflict(
    "unknown-op",
    `Unknown architecture op: ${JSON.stringify(exhaustive)}`,
    recordId,
  );
}

/** Add an intent to history and link its node intents to the current nodes. */
export function applyIntent(
  snapshot: ArchSnapshot,
  intent: Intent,
): WalConflict[] {
  snapshot.intents[intent.id] = intent;
  const conflicts: WalConflict[] = [];
  for (const nodeIntent of intent.nodeIntents) {
    const targetId = nodeIntent.facetId ?? nodeIntent.nodeId;
    const target = snapshot.nodes[targetId];
    if (!target) {
      conflicts.push({
        code: "missing-node",
        message: `Intent ${intent.id} targets missing node ${targetId}`,
        recordIds: [],
        nodeId: targetId,
      });
      continue;
    }
    target.intentId = intent.id;
    target.updatedIn = intent.versionId;
  }
  return conflicts;
}

/** Apply a code-only change marker to a node/facet and propagate it to its L1 parent. */
export function applyTouch(
  snapshot: ArchSnapshot,
  touch: Touch,
): WalConflict | null {
  const targetId = touch.facetId ?? touch.nodeId;
  const target = snapshot.nodes[targetId];
  if (!target) {
    return conflict(
      "missing-node",
      `Touch ${touch.id} targets missing node ${targetId}`,
      touch.id,
      targetId,
    );
  }
  target.lastTouchedIn = touch.versionId;
  if (touch.facetId && target.parentId) {
    const parent = snapshot.nodes[target.parentId];
    if (parent) parent.lastTouchedIn = touch.versionId;
  }
  snapshot.touches[touch.id] = touch;
  return null;
}

export function applyDecision(
  snapshot: ArchSnapshot,
  decision: Decision,
  recordId = "",
): WalConflict | null {
  if (!snapshot.versions[decision.versionId]) {
    return conflict(
      "invalid-version",
      `Decision ${decision.id} references unknown version ${decision.versionId}`,
      recordId,
    );
  }
  // `VersionState.decisions` stores WAL record ids, so key the snapshot map the
  // same way. The payload id fallback keeps direct callers working.
  snapshot.decisions[recordId || decision.id] = decision;
  return null;
}

export function applyImplementation(
  snapshot: ArchSnapshot,
  implementation: ImplementationRecord,
  recordId = "",
): WalConflict | null {
  if (!snapshot.versions[implementation.versionId]) {
    return conflict(
      "invalid-version",
      `Implementation ${implementation.id} references unknown version ${implementation.versionId}`,
      recordId,
    );
  }
  // `VersionState.implementations` stores WAL record ids, so key the snapshot
  // map the same way. Falling back to the payload id keeps direct callers and
  // pre-existing tests working when no record id is supplied.
  snapshot.implementations[recordId || implementation.id] = implementation;
  return null;
}

export function createVersionState(intent: Intent): VersionState {
  return {
    id: intent.versionId,
    intentId: intent.id,
    status: "draft",
    ordinal: null,
    ops: [],
    touches: [],
    decisions: [],
    implementations: [],
    baseHash: null,
    targetHash: null,
    diffHash: null,
    createdAt: intent.createdAt,
    updatedAt: intent.createdAt,
  };
}
