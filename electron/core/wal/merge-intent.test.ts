import { describe, expect, it } from "vite-plus/test";
import type { ArchEdge, ArchNode, ArchSnapshot } from "../../../shared/ledger/types";
import { applyOp, emptySnapshot, hashNodeForWrite } from "../arch/snapshot";
import { planMerge } from "./merge-intent";

const V1 = "01HF7YAT01W8VZEYM5S17CPH7V";
const V2 = "01HF7YAT02BPT76MP9H15XNEFG";
const NODE = "01HF7YAT06CY5XXMJ3NQ3NPBSN";

function node(patch: Partial<ArchNode> = {}): ArchNode {
  return {
    id: NODE,
    level: "L1",
    kind: "component",
    parentId: null,
    name: "Counter",
    path: "src/Counter.tsx",
    file: "src/Counter.tsx",
    symbol: "Counter",
    responsibility: "Counts clicks.",
    intentId: null,
    status: "active",
    metadata: {},
    introducedIn: V1,
    updatedIn: V1,
    lastTouchedIn: null,
    ...patch,
  };
}

function snapshot(nodes: ArchNode[], edges: ArchEdge[] = []): ArchSnapshot {
  return {
    ...emptySnapshot(),
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    edges: Object.fromEntries(edges.map((item) => [item.id, item])),
  };
}

function replay(live: ArchSnapshot, ops: Parameters<typeof applyOp>[1][]): ArchSnapshot {
  const next = { ...live, nodes: { ...live.nodes }, edges: { ...live.edges } };
  for (const op of ops) {
    const conflict = applyOp(next, op, "merge");
    expect(conflict).toBeNull();
  }
  return next;
}

describe("planMerge", () => {
  it("carries only the fields a branch changed and leaves the other branch intact", () => {
    const base = snapshot([node()]);
    const target = snapshot([node({ responsibility: "Tracks clicks per session." })]);
    const live = snapshot([node({ name: "Tally", updatedIn: V2 })]);
    const plan = planMerge(live, [{ versionId: V2, base, target }]);
    expect(plan.notes).toEqual([]);
    expect(plan.ops).toEqual([
      {
        op: "node.update",
        id: NODE,
        patch: { responsibility: "Tracks clicks per session." },
        beforeHash: hashNodeForWrite(live.nodes[NODE]!),
      },
    ]);
    const merged = replay(live, plan.ops);
    expect(merged.nodes[NODE]?.name).toBe("Tally");
    expect(merged.nodes[NODE]?.responsibility).toBe("Tracks clicks per session.");
  });

  it("keeps the current value and reports a risk when both branches changed one field", () => {
    const base = snapshot([node()]);
    const target = snapshot([node({ name: "Tally" })]);
    const live = snapshot([node({ name: "Clicker" })]);
    const plan = planMerge(live, [{ versionId: V2, base, target }]);
    expect(plan.ops).toEqual([]);
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toContain("both branches changed name");
    expect(plan.notes[0]).toContain("kept the current value");
  });

  it("does not remove a node one branch removed while the other changed it", () => {
    const base = snapshot([node()]);
    const target = snapshot([]);
    const live = snapshot([node({ responsibility: "Changed elsewhere." })]);
    const plan = planMerge(live, [{ versionId: V2, base, target }]);
    expect(plan.ops).toEqual([]);
    expect(plan.notes[0]).toContain("one branch removed it");
  });

  it("adds a node that only the skipped branch introduced", () => {
    const base = snapshot([]);
    const added = node({ id: "01HF7YAT06CY5XXMJ3NQ3NPBSX", name: "Reset" });
    const target = snapshot([added]);
    const live = snapshot([]);
    const plan = planMerge(live, [{ versionId: V2, base, target }]);
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]?.op).toBe("node.add");
    const merged = replay(live, plan.ops);
    expect(Object.keys(merged.nodes)).toEqual([added.id]);
  });

  it("does not overwrite a different node both branches added", () => {
    const base = snapshot([]);
    const target = snapshot([node({ responsibility: "Branch responsibility." })]);
    const live = snapshot([node({ responsibility: "Current responsibility." })]);
    const plan = planMerge(live, [{ versionId: V2, base, target }]);
    expect(plan.ops).toEqual([]);
    expect(plan.notes[0]).toContain("both branches added it differently");
  });

  it("merges metadata keys independently", () => {
    const base = snapshot([node({ metadata: { domain: "counter", scanned: true } })]);
    const target = snapshot([
      node({ metadata: { domain: "counter", scanned: true, owner: "team-a" } }),
    ]);
    const live = snapshot([
      node({ metadata: { domain: "counter", scanned: true, layer: "ui" } }),
    ]);
    const plan = planMerge(live, [{ versionId: V2, base, target }]);
    expect(plan.ops).toHaveLength(1);
    const patch = plan.ops[0]?.op === "node.update" ? plan.ops[0].patch : {};
    expect(patch.metadata).toEqual({ owner: "team-a" });
  });
});
