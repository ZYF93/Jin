import { describe, expect, it } from "vite-plus/test";
import type { ArchEdge, ArchNode, ArchSnapshot } from "../../../shared/ledger/types";
import { emptySnapshot, hashEdgeForWrite, hashNodeForWrite } from "../arch/snapshot";
import { diffScanToOps, scanNodeIntents } from "./import";
import type { ScanResult } from "./scanner";

function node(
  id: string,
  level: ArchNode["level"],
  kind: ArchNode["kind"],
  parentId: string | null,
  name: string,
  path: string,
  overrides: Partial<ArchNode> = {},
): ArchNode {
  return {
    id,
    level,
    kind,
    parentId,
    name,
    path,
    file: level === "L1" ? path : "",
    symbol: "",
    responsibility: `${name} responsibility.`,
    intentId: null,
    status: "active",
    metadata: { origin: "scan", scanned: true },
    introducedIn: "v1",
    updatedIn: "v1",
    lastTouchedIn: null,
    ...overrides,
  };
}

function edge(id: string, from: string, to: string, kind: ArchEdge["kind"]): ArchEdge {
  return {
    id,
    from,
    to,
    kind,
    metadata: { origin: "scan" },
    introducedIn: "v1",
  };
}

function snapshotFixture(): ArchSnapshot {
  const system = node("system", "L0", "system", null, "Fixture", "");
  const layer = node("layer", "L0", "layer", system.id, "src", "src");
  const keep = node("keep", "L1", "function", layer.id, "keep", "src/keep.ts");
  const remove = node("remove", "L1", "function", layer.id, "remove", "src/remove.ts");
  const manual = node("manual", "L1", "service", layer.id, "manual", "src/manual.ts", {
    metadata: { origin: "manual" },
  });
  return {
    ...emptySnapshot(),
    nodes: Object.fromEntries([system, layer, keep, remove, manual].map((item) => [item.id, item])),
    edges: {
      "edge-system-layer": edge("edge-system-layer", system.id, layer.id, "contains"),
      "edge-layer-keep": edge("edge-layer-keep", layer.id, keep.id, "contains"),
      "edge-layer-remove": edge("edge-layer-remove", layer.id, remove.id, "contains"),
      "edge-layer-manual": edge("edge-layer-manual", layer.id, manual.id, "contains"),
      "edge-keep-manual": edge("edge-keep-manual", keep.id, manual.id, "depends_on"),
    },
  };
}

function scanFixture(): ScanResult {
  const nodes = [
    node("system", "L0", "system", null, "Fixture", ""),
    node("layer", "L0", "layer", "system", "src", "src"),
    node("keep", "L1", "function", "layer", "keep", "src/keep.ts", {
      responsibility: "Updated responsibility.",
      metadata: { origin: "scan", scanned: true, lines: 12 },
    }),
    node("added", "L1", "function", "layer", "added", "src/added.ts"),
    node("external", "L0", "external", "system", "react", "external/react", {
      metadata: { origin: "scan", scanned: true, package: "react" },
    }),
  ].map((item) => item);
  const layerId = nodes.find((item) => item.id === "layer")?.id ?? "layer";
  const keepId = nodes.find((item) => item.id === "keep")?.id ?? "keep";
  const addedId = nodes.find((item) => item.id === "added")?.id ?? "added";
  return {
    files: [],
    nodes: nodes.map(({ introducedIn: _i, updatedIn: _u, lastTouchedIn: _l, ...draft }) => draft),
    edges: [
      {
        id: "edge-system-layer",
        from: "system",
        to: layerId,
        kind: "contains",
        metadata: { origin: "scan" },
      },
      {
        id: "edge-layer-keep",
        from: layerId,
        to: keepId,
        kind: "contains",
        metadata: { origin: "scan" },
      },
      {
        id: "edge-layer-added",
        from: layerId,
        to: addedId,
        kind: "contains",
        metadata: { origin: "scan" },
      },
      {
        id: "edge-keep-added",
        from: keepId,
        to: addedId,
        kind: "depends_on",
        metadata: { origin: "scan" },
      },
    ],
    warnings: [],
    stats: { files: 2, symbols: 0, imports: 0, nodes: 5, edges: 3, languages: {} },
    scannedAt: "2026-10-28T00:00:00.000Z",
    manifest: {},
  };
}

describe("scanNodeIntents", () => {
  it("uses each imported unit's responsibility instead of the scan task", () => {
    const intents = scanNodeIntents(scanFixture().nodes);
    expect(intents.map((intent) => [intent.nodeId, intent.statement])).toEqual([
      ["layer", "src responsibility."],
      ["keep", "Updated responsibility."],
      ["added", "added responsibility."],
    ]);
    expect(intents.every((intent) => intent.invariants.length === 0)).toBe(true);
  });
});

describe("diffScanToOps", () => {
  it("adds, updates and removes only scan-owned architecture", () => {
    const snapshot = snapshotFixture();
    const result = diffScanToOps(snapshot, scanFixture());

    expect(result.addedNodes).toBe(2);
    expect(result.updatedNodes).toBe(1);
    expect(result.removedNodes).toBe(1);
    expect(result.addedEdges).toBe(2);
    expect(result.removedEdges).toBe(2);

    const add = result.ops.find((op) => op.op === "node.add" && op.node.name === "added");
    expect(add).toBeDefined();
    expect(add?.op === "node.add" && add.node.file).toBe("src/added.ts");

    const update = result.ops.find((op) => op.op === "node.update" && op.id === "keep");
    expect(update?.op).toBe("node.update");
    if (update?.op === "node.update") {
      expect(update.patch.responsibility).toBe("Updated responsibility.");
      expect(update.patch.metadata).toEqual({
        origin: "scan",
        scanned: true,
        lines: 12,
      });
      expect(update.beforeHash).toBe(hashNodeForWrite(snapshot.nodes.keep as ArchNode));
    }

    const remove = result.ops.find((op) => op.op === "node.remove" && op.id === "remove");
    expect(remove?.op).toBe("node.remove");
    if (remove?.op === "node.remove") {
      expect(remove.beforeHash).toBe(hashNodeForWrite(snapshot.nodes.remove as ArchNode));
    }
    expect(result.ops.some((op) => op.op === "node.remove" && op.id === "manual")).toBe(false);

    const edgeRemove = result.ops.find(
      (op) => op.op === "edge.remove" && op.id === "edge-keep-manual",
    );
    expect(edgeRemove?.op).toBe("edge.remove");
    if (edgeRemove?.op === "edge.remove") {
      expect(edgeRemove.beforeHash).toBe(
        hashEdgeForWrite(snapshot.edges["edge-keep-manual"] as ArchEdge),
      );
    }
    expect(result.ops.some((op) => op.op === "edge.remove" && op.id === "edge-layer-remove")).toBe(
      false,
    );
  });

  it("returns no ops for an identical scan", () => {
    const snapshot = snapshotFixture();
    const scan = scanFixture();
    scan.nodes = Object.values(snapshot.nodes)
      .filter((item) => item.metadata.origin === "scan")
      .map(({ introducedIn: _i, updatedIn: _u, lastTouchedIn: _l, ...draft }) => draft);
    scan.edges = Object.values(snapshot.edges)
      .filter((item) => item.metadata.origin === "scan")
      .map(({ introducedIn: _i, ...draft }) => draft);
    const result = diffScanToOps(snapshot, scan);
    expect(result.ops).toEqual([]);
  });
});
