import { describe, expect, it } from "vite-plus/test";
import type { ArchDiff } from "../../shared/arch/diff";
import type { ArchNode, ArchSnapshot } from "../../shared/ledger/types";
import type { ProposalView } from "../../shared/ipc";
import {
  buildArchitectureGraph,
  type GraphReplay,
} from "./graph";

const STAMP = "2026-01-01T00:00:00.000Z";

function node(
  id: string,
  level: ArchNode["level"],
  parentId: string | null,
  overrides: Partial<ArchNode> = {},
): ArchNode {
  return {
    id,
    level,
    kind:
      level === "L0" ? "module" : level === "L1" ? "component" : "method",
    parentId,
    name: id,
    path: id,
    file: "",
    symbol: "",
    responsibility: `${id} responsibility`,
    intentId: null,
    status: "active",
    metadata: {},
    introducedIn: "v1",
    updatedIn: "v1",
    lastTouchedIn: null,
    ...overrides,
  };
}

function snapshot(nodes: ArchNode[]): ArchSnapshot {
  return {
    schemaVersion: 1,
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    edges: {},
    intents: {},
    touches: {},
    versions: {},
    decisions: {},
    implementations: {},
    lastRecordId: "record:1",
    recordCount: nodes.length,
  };
}

function diff(change: Partial<ArchDiff> = {}): ArchDiff {
  return {
    nodes: {},
    edges: {},
    colors: {},
    summary: { added: 0, removed: 0, modified: 0, affected: 0 },
    ...change,
  };
}

function proposal(
  baseSnapshot: ArchSnapshot,
  targetSnapshot: ArchSnapshot,
  graphDiff: ArchDiff,
): ProposalView {
  return {
    id: "proposal:1",
    intent: {
      id: "intent:1",
      versionId: "proposal:1",
      title: "Proposal",
      goal: "Goal",
      tasks: [],
      nodeIntents: [],
      author: { id: "user:1", kind: "user", name: "Reviewer" },
      createdAt: STAMP,
    },
    ops: [],
    touches: [],
    baseSnapshot,
    targetSnapshot,
    baseHash: "base",
    targetHash: "target",
    diffHash: "diff",
    diff: graphDiff,
    risks: [],
    reusePlan: null,
    createdAt: STAMP,
    status: "in_review",
    architectureOnly: false,
  };
}

const l0A = node("l0:a", "L0", null);
const l0B = node("l0:b", "L0", null);
const l1A1 = node("l1:a1", "L1", "l0:a");
const l1A2 = node("l1:a2", "L1", "l0:a");
const l1B1 = node("l1:b1", "L1", "l0:b");
const factA1 = node("fact:a1", "facet", "l1:a1");
const factB1 = node("fact:b1", "facet", "l1:b1");

const fullSnapshot = snapshot([
  l0A,
  l0B,
  l1A1,
  l1A2,
  l1B1,
  factA1,
  factB1,
]);

describe("buildArchitectureGraph", () => {
  it("shows only L0 modules by default and never renders facets", () => {
    const model = buildArchitectureGraph(fullSnapshot, null, {}, null);

    expect(model.mode).toBe("live");
    expect(model.reviewing).toBe(false);
    expect(model.nodes.map((item) => item.id).sort()).toEqual(["l0:a", "l0:b"]);
    expect(model.nodes.every((item) => item.data.node.level === "L0")).toBe(true);
  });

  it("reveals only the L1 units of the expanded L0 module", () => {
    const model = buildArchitectureGraph(fullSnapshot, null, { "l0:a": true }, null);
    const ids = model.nodes.map((item) => item.id).sort();

    expect(ids).toEqual(["l0:a", "l0:b", "l1:a1", "l1:a2"]);
    expect(model.nodes.some((item) => item.data.node.level === "facet")).toBe(false);

    const unit = model.nodes.find((item) => item.id === "l1:a1");
    expect(unit?.data.childCount).toBe(1);
    expect(unit?.data.expandable).toBe(false);
  });

  it("keeps removed L1 units visible inside an expanded L0 diff", () => {
    const target = snapshot([l0A, l1A1, factA1]);
    const removedUnit = node("l1:gone", "L1", "l0:a");
    const graphDiff = diff({
      nodes: {
        "l1:gone": {
          id: "l1:gone",
          change: "removed",
          before: removedUnit,
          after: null,
          fields: [],
          propagated: false,
        },
        "fact:a1": {
          id: "fact:a1",
          change: "modified",
          before: factA1,
          after: factA1,
          fields: ["name"],
          propagated: false,
        },
      },
      colors: { "l0:a": "modified", "l1:a1": "modified" },
      summary: { added: 0, removed: 1, modified: 1, affected: 2 },
    });
    const model = buildArchitectureGraph(
      fullSnapshot,
      proposal(snapshot([l0A, l1A1, l1A2, factA1]), target, graphDiff),
      { "l0:a": true },
      null,
    );

    expect(model.mode).toBe("proposal");
    expect(model.reviewing).toBe(true);
    const gone = model.nodes.find((item) => item.id === "l1:gone");
    expect(gone?.data.change).toBe("removed");
    expect(model.nodes.some((item) => item.id === "fact:a1")).toBe(false);

    const parent = model.nodes.find((item) => item.id === "l0:a");
    expect(parent?.data.childCount).toBe(2);
    const unit = model.nodes.find((item) => item.id === "l1:a1");
    expect(unit?.data.factChanges).toEqual({ added: 0, removed: 0, modified: 1 });
  });

  it("includes removed L0 modules in a proposal diff", () => {
    const base = snapshot([l0A, l0B]);
    const target = snapshot([l0A]);
    const graphDiff = diff({
      nodes: {
        "l0:b": {
          id: "l0:b",
          change: "removed",
          before: l0B,
          after: null,
          fields: [],
          propagated: false,
        },
      },
      colors: { "l0:b": "removed" },
      summary: { added: 0, removed: 1, modified: 0, affected: 1 },
    });

    const model = buildArchitectureGraph(
      target,
      proposal(base, target, graphDiff),
      {},
      null,
    );

    expect(model.mode).toBe("proposal");
    expect(model.nodes.map((item) => item.id).sort()).toEqual(["l0:a", "l0:b"]);
    expect(model.nodes.find((item) => item.id === "l0:b")?.data.change).toBe("removed");
  });

  it("uses the replay snapshots and marks the mode as replay", () => {
    const replay: GraphReplay = {
      id: "version:7",
      baseSnapshot: snapshot([node("l0:a", "L0", null, { name: "Old" })]),
      targetSnapshot: snapshot([
        node("l0:a", "L0", null, { name: "New" }),
        node("l0:b", "L0", null),
      ]),
      diff: diff({
        nodes: {
          "l0:a": {
            id: "l0:a",
            change: "modified",
            before: node("l0:a", "L0", null, { name: "Old" }),
            after: node("l0:a", "L0", null, { name: "New" }),
            fields: ["name"],
            propagated: false,
          },
          "l0:b": {
            id: "l0:b",
            change: "added",
            before: null,
            after: node("l0:b", "L0", null),
            fields: [],
            propagated: false,
          },
        },
        colors: { "l0:a": "modified", "l0:b": "added" },
        summary: { added: 1, removed: 0, modified: 1, affected: 2 },
      }),
    };

    const model = buildArchitectureGraph(
      fullSnapshot,
      null,
      {},
      "l0:a",
      replay,
    );

    expect(model.mode).toBe("replay");
    expect(model.reviewing).toBe(true);
    expect(model.signature.startsWith("replay:version:7")).toBe(true);
    expect(model.nodes.find((item) => item.id === "l0:a")?.data.change).toBe("modified");
    expect(model.nodes.find((item) => item.id === "l0:a")?.data.selected).toBe(true);
    expect(model.nodes.find((item) => item.id === "l0:b")?.data.change).toBe("added");
  });

  it("returns an empty model when there is no snapshot or replay", () => {
    const model = buildArchitectureGraph(null, null, {}, null);

    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.nodeCount).toBe(0);
    expect(model.mode).toBe("live");
  });

  it("renders nested L0 owners as regions and grows one when its L1 is revealed", () => {
    const system = node("l0:sys", "L0", null, { kind: "system" });
    const layer = node("l0:layer", "L0", "l0:sys", { kind: "layer" });
    const core = node("l0:core", "L0", "l0:layer");
    const mod = node("l0:mod", "L0", "l0:core");
    const external = node("l0:ext", "L0", "l0:sys", { kind: "external" });
    const l1x = node("l1:x", "L1", "l0:mod");
    const l1y = node("l1:y", "L1", "l0:mod");
    const factX = node("fact:x", "facet", "l1:x");
    const graph = snapshot([
      system,
      layer,
      core,
      mod,
      external,
      l1x,
      l1y,
      factX,
    ]);

    const collapsed = buildArchitectureGraph(graph, null, {}, null);
    const collapsedById = new Map(collapsed.nodes.map((item) => [item.id, item]));

    expect(collapsedById.get("l0:sys")?.parentId).toBeUndefined();
    expect(collapsedById.get("l0:sys")?.data.region).toBe(true);
    expect(collapsedById.get("l0:layer")?.parentId).toBe("l0:sys");
    expect(collapsedById.get("l0:layer")?.data.region).toBe(true);
    expect(collapsedById.get("l0:core")?.parentId).toBe("l0:layer");
    expect(collapsedById.get("l0:core")?.data.region).toBe(true);
    expect(collapsedById.get("l0:mod")?.data.region).toBe(false);
    // External packages stay root-level cards instead of inflating the system.
    expect(collapsedById.get("l0:ext")?.parentId).toBeUndefined();
    expect(collapsedById.get("l0:sys")?.data.moduleCount).toBe(1);
    expect(collapsedById.get("l0:core")?.data.moduleCount).toBe(1);
    expect(collapsedById.get("l0:mod")?.data.childCount).toBe(2);
    expect(collapsedById.get("l0:mod")?.data.expandable).toBe(true);
    expect(collapsedById.has("l1:x")).toBe(false);
    expect(collapsedById.has("fact:x")).toBe(false);

    const expanded = buildArchitectureGraph(graph, null, { "l0:mod": true }, null);
    const expandedById = new Map(expanded.nodes.map((item) => [item.id, item]));

    expect(expanded.layoutKey).toBe(collapsed.layoutKey);
    expect(expanded.signature).not.toBe(collapsed.signature);
    expect(expandedById.get("l1:x")?.parentId).toBe("l0:mod");
    expect(expandedById.get("l1:y")?.parentId).toBe("l0:mod");
    expect(expandedById.has("fact:x")).toBe(false);
    expect(expandedById.get("l0:mod")?.data.region).toBe(true);
    expect(expandedById.get("l0:mod")?.height).toBeGreaterThan(
      collapsedById.get("l0:mod")?.height ?? 0,
    );
  });

  it("focuses one node on its direct relations and hides unrelated edges", () => {
    const a = node("l0:a", "L0", null);
    const b = node("l0:b", "L0", null);
    const c = node("l0:c", "L0", null);
    const unitB = node("l1:b1", "L1", "l0:b");
    const graph = snapshot([a, b, c, unitB]);
    graph.edges = {
      "edge:a-b": {
        id: "edge:a-b",
        from: "l0:a",
        to: "l0:b",
        kind: "depends_on",
        metadata: {},
        introducedIn: "v1",
      },
      "edge:b-unit": {
        id: "edge:b-unit",
        from: "l0:b",
        to: "l1:b1",
        kind: "uses",
        metadata: {},
        introducedIn: "v1",
      },
      "edge:b-c": {
        id: "edge:b-c",
        from: "l0:b",
        to: "l0:c",
        kind: "references",
        metadata: {},
        introducedIn: "v1",
      },
      "edge:contains": {
        id: "edge:contains",
        from: "l0:b",
        to: "l1:b1",
        kind: "contains",
        metadata: {},
        introducedIn: "v1",
      },
    };

    const model = buildArchitectureGraph(
      graph,
      null,
      {},
      "l0:b",
      null,
      "l0:b",
    );
    const ids = model.nodes.map((item) => item.id).sort();

    expect(model.focus).toBe("l0:b");
    expect(ids).toEqual(["l0:a", "l0:b", "l0:c", "l1:b1"]);
    expect(model.edges.map((edge) => edge.id).sort()).toEqual([
      "edge:a-b",
      "edge:b-c",
      "edge:b-unit",
    ]);
    expect(model.signature).toContain("l0:b");

    const unfocused = buildArchitectureGraph(graph, null, {}, null);
    expect(unfocused.focus).toBeNull();
    expect(unfocused.nodes.map((item) => item.id).sort()).toEqual([
      "l0:a",
      "l0:b",
      "l0:c",
    ]);
  });
});
