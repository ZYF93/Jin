import type {
  ArchEdgeDraft,
  ArchNode,
  ArchNodeDraft,
  ArchOp,
  ArchSnapshot,
  L0Kind,
  L1Kind,
  NodeIntent,
  NodeKind,
  NodeStatus,
} from "../../../shared/arch/types";
import { hashEdgeForWrite, hashNodeForWrite } from "../arch/snapshot";
import { isStableId, stableIds } from "../ids/stable";
import { isUlid } from "../ids/ulid";
import type { NodePatch, NormalizedPlan, PlanDraft } from "./plan-types";

const L0_KINDS = new Set<string>(["system", "domain", "module", "layer", "external"]);
const L1_KINDS = new Set<string>([
  "component",
  "hook",
  "entity",
  "service",
  "repository",
  "route",
  "store",
  "type",
  "function",
  "table",
  "schema",
  "config",
]);
const FACET_KINDS = new Set<string>(["method", "field", "property"]);
const STATUSES = new Set<string>(["active", "planned", "deprecated"]);

function nodeKindForLevel(level: string, kind: string): NodeKind | null {
  if (level === "L0" && L0_KINDS.has(kind)) return kind as L0Kind;
  if (level === "L1" && L1_KINDS.has(kind)) return kind as L1Kind;
  if (level === "facet" && FACET_KINDS.has(kind)) return kind as NodeKind;
  return null;
}

function findSystemId(snapshot: ArchSnapshot): string | null {
  return (
    Object.values(snapshot.nodes).find(
      (node) => node.level === "L0" && node.kind === "system",
    )?.id ?? null
  );
}

interface DraftAdd {
  raw: Extract<PlanDraft["ops"][number], { op: "node.add" }>["node"];
  level: ArchNodeDraft["level"];
  kind: NodeKind;
  actualId: string;
  suggestedId: string;
}

/**
 * Turn a planner's loose ids and patches into legal WAL ops. LLM output is
 * untrusted: every id, parent, kind, and optimistic-concurrency hash is checked
 * here, before the user sees the proposal.
 */
export function normalizePlan(
  plan: PlanDraft,
  snapshot: ArchSnapshot,
  _versionId: string,
): NormalizedPlan {
  const warnings: string[] = [];
  const idMap = new Map<string, string>();
  const fallbackParent = findSystemId(snapshot);
  const draftAdds = new Map<string, DraftAdd>();
  const reservedIds = new Set<string>();

  const resolveId = (value: string | null | undefined): string | null => {
    if (!value) return null;
    return idMap.get(value) ?? (snapshot.nodes[value] ? value : null);
  };

  // Pass 1: establish every new id first, including placeholders that later
  // nodes use as parents. No operation is emitted in this pass.
  for (const planned of plan.ops) {
    if (planned.op !== "node.add") continue;
    const raw = planned.node;
    const kind = nodeKindForLevel(raw.level, raw.kind);
    if (!kind) {
      warnings.push(`Skipped ${raw.level}/${raw.kind} "${raw.name}" because its kind is invalid`);
      continue;
    }
    const suggested = raw.id ?? "";
    const naturalSeed = `${raw.level}:${kind}:${raw.parentId ?? ""}:${raw.path || raw.name}:${raw.name}`;
    const stableSeed =
      raw.level === "L0"
        ? raw.path || raw.name
        : raw.level === "L1"
          ? raw.file || raw.path || raw.name
          : `${raw.parentId ?? ""}:${raw.name}`;
    let actualId =
      isUlid(suggested) && !snapshot.nodes[suggested]
        ? suggested
        : stableIds.node(
            raw.level === "L0" ? "module" : raw.level === "L1" ? "file" : "facet",
            stableSeed,
          );
    let suffix = 2;
    while (reservedIds.has(actualId)) {
      actualId = stableIds.node(
        raw.level === "L0" ? "module" : raw.level === "L1" ? "file" : "facet",
        `${stableSeed}:${naturalSeed}:${suffix}`,
      );
      suffix += 1;
    }
    reservedIds.add(actualId);
    if (suggested) idMap.set(suggested, actualId);
    if (draftAdds.has(actualId)) {
      warnings.push(`Skipped duplicate new node "${raw.name}"`);
      continue;
    }
    draftAdds.set(actualId, { raw, level: raw.level, kind, actualId, suggestedId: suggested });
  }

  const updates = new Map<string, NodePatch>();
  const removedAdded = new Set<string>();
  const removes = new Set<string>();
  const edgeDrafts = new Map<string, ArchEdgeDraft>();

  const addUpdate = (id: string, patch: NodePatch): void => {
    const current = updates.get(id) ?? {};
    updates.set(id, { ...current, ...patch });
  };

  // Pass 2: resolve updates/removals, folding updates that target a node added
  // by this same proposal into its draft.
  for (const planned of plan.ops) {
    if (planned.op === "node.add") continue;
    if (planned.op === "node.update") {
      const id = resolveId(planned.id);
      if (!id || (!snapshot.nodes[id] && !draftAdds.has(id))) {
        warnings.push(`Skipped update of unknown node ${planned.id}`);
        continue;
      }
      const patch: NodePatch = { ...planned.patch };
      if (patch.parentId !== undefined) {
        patch.parentId = resolveId(patch.parentId) ?? fallbackParent;
      }
      const draft = draftAdds.get(id);
      if (draft) {
        if (patch.name) draft.raw = { ...draft.raw, name: patch.name };
        if (patch.path !== undefined) draft.raw = { ...draft.raw, path: patch.path };
        if (patch.file !== undefined) draft.raw = { ...draft.raw, file: patch.file };
        if (patch.responsibility) {
          draft.raw = { ...draft.raw, responsibility: patch.responsibility };
        }
        if (patch.status && STATUSES.has(patch.status)) {
          draft.raw = { ...draft.raw, status: patch.status };
        }
        if (patch.metadata) {
          draft.raw = {
            ...draft.raw,
            metadata: { ...draft.raw.metadata, ...patch.metadata },
          };
        }
        if (patch.parentId !== undefined) {
          draft.raw = { ...draft.raw, parentId: patch.parentId };
        }
        continue;
      }
      addUpdate(id, patch);
      continue;
    }
    if (planned.op === "node.remove") {
      const id = resolveId(planned.id);
      if (!id || (!snapshot.nodes[id] && !draftAdds.has(id))) {
        warnings.push(`Skipped removal of unknown node ${planned.id}`);
        continue;
      }
      if (draftAdds.has(id)) {
        removedAdded.add(id);
        draftAdds.delete(id);
      } else if (snapshot.nodes[id]?.kind === "system") {
        warnings.push("Refused to remove the system node");
      } else {
        removes.add(id);
      }
      continue;
    }
    if (planned.op === "edge.add") {
      const from = resolveId(planned.edge.from);
      const to = resolveId(planned.edge.to);
      if (!from || !to) {
        warnings.push("Skipped an edge whose endpoint was not found");
        continue;
      }
      const id = isStableId(planned.edge.id)
        ? planned.edge.id
        : stableIds.edge(from, planned.edge.kind, to);
      if (snapshot.edges[id] || edgeDrafts.has(id)) continue;
      edgeDrafts.set(id, {
        id,
        from,
        to,
        kind: planned.edge.kind,
        metadata: { ...planned.edge.metadata, origin: "agent" },
      });
      continue;
    }
    if (planned.op === "edge.remove") {
      if (!snapshot.edges[planned.id]) {
        warnings.push(`Skipped removal of unknown edge ${planned.id}`);
      }
    }
  }

  const adds: ArchNodeDraft[] = [];
  const addedIds = new Set<string>();
  for (const draft of draftAdds.values()) {
    if (removedAdded.has(draft.actualId)) continue;
    const existing = snapshot.nodes[draft.actualId];
    if (existing) {
      addUpdate(draft.actualId, {
        responsibility: draft.raw.responsibility || existing.responsibility,
        status: "active",
      });
      continue;
    }
    let parentId =
      resolveId(draft.raw.parentId) ??
      (draft.raw.parentId ? fallbackParent : null);
    if (draft.level === "L0" && draft.kind !== "system" && !parentId) {
      parentId = fallbackParent;
    }
    if (draft.raw.parentId && !resolveId(draft.raw.parentId)) {
      warnings.push(`New node "${draft.raw.name}" referenced an unknown parent; attached to the system root`);
    }
    const status: NodeStatus = STATUSES.has(draft.raw.status ?? "")
      ? (draft.raw.status as NodeStatus)
      : "planned";
    const node: ArchNodeDraft = {
      id: draft.actualId,
      level: draft.level,
      kind: draft.kind,
      parentId,
      name: draft.raw.name.slice(0, 160),
      path: draft.raw.path.trim(),
      file: draft.raw.file,
      symbol: draft.raw.symbol,
      responsibility: draft.raw.responsibility.slice(0, 600),
      intentId: null,
      status,
      metadata: { ...draft.raw.metadata, origin: "agent", planned: true },
    };
    adds.push(node);
    addedIds.add(node.id);
    if (node.parentId) {
      const edgeId = stableIds.edge(node.parentId, "contains", node.id);
      if (!snapshot.edges[edgeId] && !edgeDrafts.has(edgeId)) {
        edgeDrafts.set(edgeId, {
          id: edgeId,
          from: node.parentId,
          to: node.id,
          kind: "contains",
          metadata: { origin: "agent" },
        });
      }
    }
  }

  const ops: ArchOp[] = [];
  adds.sort((a, b) => {
    const order = { L0: 0, L1: 1, facet: 2 };
    return order[a.level] - order[b.level];
  });
  for (const node of adds) ops.push({ op: "node.add", node });
  for (const [id, patch] of updates) {
    const node = snapshot.nodes[id];
    if (!node) continue;
    ops.push({
      op: "node.update",
      id,
      patch,
      beforeHash: hashNodeForWrite(node),
    });
  }
  for (const id of removes) {
    const node = snapshot.nodes[id];
    if (!node) continue;
    ops.push({ op: "node.remove", id, beforeHash: hashNodeForWrite(node) });
  }
  for (const edge of edgeDrafts.values()) {
    if (!snapshot.nodes[edge.from] && !addedIds.has(edge.from)) continue;
    if (!snapshot.nodes[edge.to] && !addedIds.has(edge.to)) continue;
    ops.push({ op: "edge.add", edge });
  }
  for (const planned of plan.ops) {
    if (planned.op !== "edge.remove") continue;
    const edge = snapshot.edges[planned.id];
    if (!edge) continue;
    ops.push({
      op: "edge.remove",
      id: planned.id,
      beforeHash: hashEdgeForWrite(edge),
    });
  }

  const nodeIntents: NodeIntent[] = [];
  for (const planned of plan.nodeIntents) {
    const nodeId = resolveId(planned.nodeId) ?? planned.nodeId;
    const facetId = planned.facetId
      ? resolveId(planned.facetId) ?? planned.facetId
      : undefined;
    const targetId = facetId ?? nodeId;
    if (!snapshot.nodes[targetId] && !addedIds.has(targetId)) {
      warnings.push(`Skipped node intent for unknown target ${targetId}`);
      continue;
    }
    nodeIntents.push({
      nodeId,
      ...(facetId ? { facetId } : {}),
      statement: planned.statement,
      invariants: planned.invariants ?? [],
      acceptance: planned.acceptance ?? [],
    });
  }

  return { ops, nodeIntents, warnings };
}

export function findNodeByHint(snapshot: ArchSnapshot, hint: string): ArchNode | null {
  const lower = hint.toLowerCase();
  return (
    Object.values(snapshot.nodes).find(
      (node) =>
        node.id === hint ||
        node.name.toLowerCase() === lower ||
        node.path.toLowerCase() === lower ||
        node.file.toLowerCase() === lower ||
        `${node.name} ${node.path} ${node.file}`.toLowerCase().includes(lower),
    ) ?? null
  );
}
