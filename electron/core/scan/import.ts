import type {
  ArchEdge,
  ArchNode,
  ArchNodeDraft,
  ArchOp,
  ArchSnapshot,
  Intent,
} from "../../../shared/ledger/types";
import { hashEdgeForWrite, hashNodeForWrite } from "../arch/snapshot";
import type { ScanResult } from "./scanner";

const SCAN_FIELDS: ReadonlyArray<
  "kind" | "name" | "path" | "file" | "symbol" | "responsibility" | "parentId"
> = ["kind", "name", "path", "file", "symbol", "responsibility", "parentId"];

function isScanNode(node: ArchNode): boolean {
  return node.metadata.scanned === true || node.metadata.origin === "scan";
}

function isScanEdge(edge: ArchEdge): boolean {
  return edge.metadata.origin === "scan";
}

export interface ScanImportResult {
  ops: ArchOp[];
  addedNodes: number;
  updatedNodes: number;
  removedNodes: number;
  addedEdges: number;
  removedEdges: number;
}

/** Give imported architecture nodes their source-derived purpose, separate from the scan task. */
export function scanNodeIntents(nodes: readonly ArchNodeDraft[]): Intent["nodeIntents"] {
  return nodes
    .filter(
      (node) =>
        node.level === "L1" ||
        (node.level === "L0" && node.kind !== "system" && node.kind !== "external"),
    )
    .map((node) => ({
      nodeId: node.id,
      statement: node.responsibility,
      invariants: [],
      acceptance: [],
    }));
}

/**
 * Turn a fresh structural scan into a reviewable set of ops. Only scan-owned
 * nodes/edges can be removed; manually approved architecture survives a rescan.
 */
export function diffScanToOps(snapshot: ArchSnapshot, scan: ScanResult): ScanImportResult {
  const scannedNodes = new Map(scan.nodes.map((node) => [node.id, node]));
  const scannedEdges = new Map(scan.edges.map((edge) => [edge.id, edge]));

  const adds = scan.nodes.filter((node) => !snapshot.nodes[node.id]);
  const updates: Array<{ before: ArchNode; after: (typeof scan.nodes)[number] }> = [];
  for (const after of scan.nodes) {
    const before = snapshot.nodes[after.id];
    if (!before || !isScanNode(before)) continue;
    const changed =
      SCAN_FIELDS.some((field) => before[field] !== after[field]) ||
      JSON.stringify(before.metadata) !==
        JSON.stringify({ ...before.metadata, ...after.metadata, origin: "scan" });
    if (changed) updates.push({ before, after });
  }

  const removable = Object.values(snapshot.nodes).filter(
    (node) => isScanNode(node) && !scannedNodes.has(node.id) && node.kind !== "system",
  );
  const removedIds = new Set(removable.map((node) => node.id));

  const edgeAdds = scan.edges.filter((edge) => !snapshot.edges[edge.id]);
  const edgeRemoves = Object.values(snapshot.edges).filter(
    (edge) =>
      isScanEdge(edge) &&
      !scannedEdges.has(edge.id) &&
      !removedIds.has(edge.from) &&
      !removedIds.has(edge.to),
  );

  const ops: ArchOp[] = [];
  const sortedAdds = [...adds].sort((a, b) => {
    const order = { L0: 0, L1: 1, facet: 2 };
    return order[a.level] - order[b.level];
  });
  for (const node of sortedAdds) {
    ops.push({ op: "node.add", node });
  }

  for (const { before, after } of updates) {
    const patch: Record<string, unknown> = {};
    for (const field of SCAN_FIELDS) {
      if (before[field] !== after[field]) patch[field] = after[field];
    }
    const mergedMetadata = { ...before.metadata, ...after.metadata, origin: "scan" };
    if (JSON.stringify(before.metadata) !== JSON.stringify(mergedMetadata)) {
      patch.metadata = mergedMetadata;
    }
    if (Object.keys(patch).length === 0) continue;
    ops.push({
      op: "node.update",
      id: before.id,
      patch,
      beforeHash: hashNodeForWrite(before),
    });
  }

  for (const edge of edgeAdds) {
    ops.push({ op: "edge.add", edge });
  }
  for (const edge of edgeRemoves) {
    ops.push({
      op: "edge.remove",
      id: edge.id,
      beforeHash: hashEdgeForWrite(edge),
    });
  }

  const sortedRemovals = [...removable].sort(
    (a, b) => b.path.split("/").length - a.path.split("/").length,
  );
  for (const node of sortedRemovals) {
    ops.push({
      op: "node.remove",
      id: node.id,
      beforeHash: hashNodeForWrite(node),
    });
  }

  return {
    ops,
    addedNodes: adds.length,
    updatedNodes: updates.length,
    removedNodes: removable.length,
    addedEdges: edgeAdds.length,
    removedEdges: edgeRemoves.length,
  };
}
