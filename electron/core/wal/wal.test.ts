import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type {
  Actor,
  ArchNodeDraft,
  Intent,
  NodeIntent,
  Touch,
} from "../../../shared/arch/types";
import type { WalRecord } from "../../../shared/wal/types";
import {
  diffHashForVersion,
  emptySnapshot,
  hashNodeForWrite,
  hashSnapshot,
} from "../arch/snapshot";
import { hashValue } from "../hash/canonical";
import { ulid } from "../ids/ulid";
import { formatHlc } from "../time/hlc";
import { foldWal } from "./fold";
import { appendRecord, loadWal, writeWalAtomic } from "./io";
import { mergeWalRecords } from "./merge";
import { sealRecord } from "./record";

const ACTOR: Actor = { id: "user:test", kind: "user", name: "Test" };
const BASE_TIME = 1_700_000_000_000;
let idCounter = 0;
let hlcCounter = 0;

function nextId(): string {
  idCounter += 1;
  return ulid(BASE_TIME + idCounter);
}

function nextHlc(): string {
  hlcCounter += 1;
  return formatHlc({
    wall: BASE_TIME + hlcCounter,
    counter: 0,
    actor: "test",
  });
}

function makeNode(
  id: string,
  name: string,
  overrides: Partial<ArchNodeDraft> = {},
): ArchNodeDraft {
  return {
    id,
    level: "L1",
    kind: "component",
    parentId: null,
    name,
    path: `src/${name}`,
    file: `src/${name}.tsx`,
    symbol: name,
    responsibility: "",
    intentId: null,
    status: "active",
    metadata: {},
    ...overrides,
  };
}

function makeFacet(id: string, parentId: string, name: string): ArchNodeDraft {
  return makeNode(id, name, {
    level: "facet",
    kind: "method",
    parentId,
    path: "",
    file: "",
    symbol: name,
  });
}

function makeIntent(
  versionId: string,
  title: string,
  nodeIntents: NodeIntent[] = [],
): Intent {
  return {
    id: nextId(),
    versionId,
    title,
    goal: `Goal for ${title}`,
    tasks: [],
    nodeIntents,
    author: ACTOR,
    createdAt: new Date(BASE_TIME + idCounter).toISOString(),
  };
}

function intentRecord(intent: Intent, parents: string[] = []): WalRecord {
  return sealRecord({
    t: "intent",
    id: nextId(),
    versionId: intent.versionId,
    actor: ACTOR,
    hlc: nextHlc(),
    parents,
    payload: intent,
  });
}

function opRecord(
  versionId: string,
  payload: Extract<WalRecord, { t: "op" }>["payload"],
  parents: string[] = [],
): WalRecord {
  return sealRecord({
    t: "op",
    id: nextId(),
    versionId,
    actor: ACTOR,
    hlc: nextHlc(),
    parents,
    payload,
  });
}

function decisionRecord(
  versionId: string,
  decision: "approved" | "rejected",
  diffHash: string | undefined,
  parents: string[] = [],
): WalRecord {
  const emptyHash = hashSnapshot(emptySnapshot());
  return sealRecord({
    t: "decision",
    id: nextId(),
    versionId,
    actor: ACTOR,
    hlc: nextHlc(),
    parents,
    payload: {
      id: nextId(),
      versionId,
      decision,
      by: ACTOR,
      note: "",
      baseHash: emptyHash,
      targetHash: emptyHash,
      diffHash,
      signature: "test",
      createdAt: new Date(BASE_TIME + idCounter).toISOString(),
    },
  });
}

function makeTouch(
  versionId: string,
  intentId: string,
  nodeId: string,
  facetId: string,
  parents: string[] = [],
): { record: WalRecord; touchId: string } {
  const touchId = nextId();
  const payload: Touch = {
    id: touchId,
    versionId,
    intentId,
    nodeId,
    facetId,
    reason: "Small code-only change",
    codeRefs: ["src/ChatPanel.tsx"],
    tests: [],
    actor: ACTOR,
    createdAt: new Date(BASE_TIME + idCounter).toISOString(),
  };
  const record = sealRecord({
    t: "touch",
    id: nextId(),
    versionId,
    actor: ACTOR,
    hlc: nextHlc(),
    parents,
    payload,
  });
  return { record, touchId };
}

describe("foldWal", () => {
  it("applies an approved structural version", () => {
    const versionId = nextId();
    const nodeId = nextId();
    const intent = makeIntent(versionId, "Add ChatPanel", [
      {
        nodeId,
        statement: "Own the chat surface",
        invariants: [],
        acceptance: [],
      },
    ]);
    const intentRec = intentRecord(intent);
    const op = opRecord(
      versionId,
      { op: "node.add", node: makeNode(nodeId, "ChatPanel") },
      [intentRec.id],
    );
    const decision = decisionRecord(
      versionId,
      "approved",
      diffHashForVersion(intent, [op], []),
      [op.id],
    );

    const result = foldWal([intentRec, op, decision]);

    expect(result.conflicts).toEqual([]);
    expect(result.snapshot.nodes[nodeId]?.name).toBe("ChatPanel");
    expect(result.snapshot.nodes[nodeId]?.intentId).toBe(intent.id);
    expect(result.snapshot.versions[versionId]?.status).toBe("approved");
    expect(result.snapshot.versions[versionId]?.ordinal).toBe(1);
    expect(result.snapshot.recordCount).toBe(3);
  });

  it("keeps draft and rejected versions in history without applying them", () => {
    const draftVersion = nextId();
    const rejectedVersion = nextId();
    const draftNode = nextId();
    const rejectedNode = nextId();

    const draftIntent = makeIntent(draftVersion, "Draft");
    const draftIntentRec = intentRecord(draftIntent);
    const draftOp = opRecord(
      draftVersion,
      { op: "node.add", node: makeNode(draftNode, "DraftNode") },
      [draftIntentRec.id],
    );

    const rejectedIntent = makeIntent(rejectedVersion, "Rejected");
    const rejectedIntentRec = intentRecord(rejectedIntent, [draftOp.id]);
    const rejectedOp = opRecord(
      rejectedVersion,
      { op: "node.add", node: makeNode(rejectedNode, "RejectedNode") },
      [rejectedIntentRec.id],
    );
    const rejectedDecision = decisionRecord(
      rejectedVersion,
      "rejected",
      diffHashForVersion(rejectedIntent, [rejectedOp], []),
      [rejectedOp.id],
    );

    const result = foldWal([
      draftIntentRec,
      draftOp,
      rejectedIntentRec,
      rejectedOp,
      rejectedDecision,
    ]);

    expect(result.snapshot.nodes[draftNode]).toBeUndefined();
    expect(result.snapshot.nodes[rejectedNode]).toBeUndefined();
    expect(result.snapshot.versions[draftVersion]?.status).toBe("draft");
    expect(result.snapshot.versions[rejectedVersion]?.status).toBe("rejected");
    expect(result.snapshot.intents[draftIntent.id]?.title).toBe("Draft");
    expect(result.snapshot.versions[draftVersion]?.ordinal).toBe(1);
    expect(result.snapshot.versions[rejectedVersion]?.ordinal).toBe(2);
  });

  it("applies touch-only versions and propagates the touch to the L1 parent", () => {
    const baseVersion = nextId();
    const touchVersion = nextId();
    const componentId = nextId();
    const methodId = nextId();

    const baseIntent = makeIntent(baseVersion, "Add component", [
      {
        nodeId: componentId,
        facetId: methodId,
        statement: "Render the chat",
        invariants: [],
        acceptance: [],
      },
    ]);
    const baseIntentRec = intentRecord(baseIntent);
    const componentOp = opRecord(
      baseVersion,
      { op: "node.add", node: makeNode(componentId, "ChatPanel") },
      [baseIntentRec.id],
    );
    const methodOp = opRecord(
      baseVersion,
      {
        op: "node.add",
        node: makeFacet(methodId, componentId, "handleClick"),
      },
      [componentOp.id],
    );
    const baseDecision = decisionRecord(
      baseVersion,
      "approved",
      diffHashForVersion(baseIntent, [componentOp, methodOp], []),
      [methodOp.id],
    );

    const touchIntent = makeIntent(touchVersion, "Tweak click handling");
    const touchIntentRec = intentRecord(touchIntent, [baseDecision.id]);
    const touch = makeTouch(
      touchVersion,
      touchIntent.id,
      componentId,
      methodId,
      [touchIntentRec.id],
    );
    const touchDecision = decisionRecord(
      touchVersion,
      "approved",
      diffHashForVersion(touchIntent, [], [touch.record]),
      [touch.record.id],
    );

    const result = foldWal([
      baseIntentRec,
      componentOp,
      methodOp,
      baseDecision,
      touchIntentRec,
      touch.record,
      touchDecision,
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.snapshot.touches[touch.touchId]).toBeDefined();
    expect(result.snapshot.nodes[methodId]?.lastTouchedIn).toBe(touchVersion);
    expect(result.snapshot.nodes[componentId]?.lastTouchedIn).toBe(touchVersion);
    expect(result.snapshot.versions[touchVersion]?.status).toBe("approved");
  });

  it("rejects an approval whose diffHash does not match the reviewed change", () => {
    const versionId = nextId();
    const nodeId = nextId();
    const intent = makeIntent(versionId, "Tampered");
    const intentRec = intentRecord(intent);
    const op = opRecord(
      versionId,
      { op: "node.add", node: makeNode(nodeId, "TamperedNode") },
      [intentRec.id],
    );
    const decision = decisionRecord(
      versionId,
      "approved",
      hashValue({ tampered: true }),
      [op.id],
    );

    const result = foldWal([intentRec, op, decision]);

    expect(result.snapshot.nodes[nodeId]).toBeUndefined();
    expect(result.snapshot.versions[versionId]?.status).toBe("conflicted");
    expect(
      result.conflicts.some((conflict) => conflict.code === "approval-mismatch"),
    ).toBe(true);
  });

  it("detects cycles in the causal graph", () => {
    const versionId = nextId();
    const idA = nextId();
    const idB = nextId();
    const recordA = sealRecord({
      t: "op",
      id: idA,
      versionId,
      actor: ACTOR,
      hlc: nextHlc(),
      parents: [idB],
      payload: { op: "node.add", node: makeNode(nextId(), "A") },
    });
    const recordB = sealRecord({
      t: "op",
      id: idB,
      versionId,
      actor: ACTOR,
      hlc: nextHlc(),
      parents: [idA],
      payload: { op: "node.add", node: makeNode(nextId(), "B") },
    });

    const result = foldWal([recordA, recordB]);

    expect(result.conflicts.some((conflict) => conflict.code === "cycle")).toBe(
      true,
    );
    expect(result.snapshot.nodes).toEqual({});
  });
});

describe("mergeWalRecords", () => {
  it("merges disjoint approved branches", () => {
    const versionA = nextId();
    const versionB = nextId();
    const nodeA = nextId();
    const nodeB = nextId();

    const intentA = makeIntent(versionA, "Branch A");
    const intentARec = intentRecord(intentA);
    const opA = opRecord(
      versionA,
      { op: "node.add", node: makeNode(nodeA, "NodeA") },
      [intentARec.id],
    );
    const decisionA = decisionRecord(
      versionA,
      "approved",
      diffHashForVersion(intentA, [opA], []),
      [opA.id],
    );

    const intentB = makeIntent(versionB, "Branch B");
    const intentBRec = intentRecord(intentB);
    const opB = opRecord(
      versionB,
      { op: "node.add", node: makeNode(nodeB, "NodeB") },
      [intentBRec.id],
    );
    const decisionB = decisionRecord(
      versionB,
      "approved",
      diffHashForVersion(intentB, [opB], []),
      [opB.id],
    );

    const merged = mergeWalRecords(
      [],
      [intentARec, opA, decisionA],
      [intentBRec, opB, decisionB],
    );

    expect(merged.parseErrors).toEqual([]);
    expect(merged.conflicts).toEqual([]);
    expect(merged.snapshot.nodes[nodeA]?.name).toBe("NodeA");
    expect(merged.snapshot.nodes[nodeB]?.name).toBe("NodeB");
    expect(merged.records).toHaveLength(6);
    expect(merged.text.split("\n").filter(Boolean)).toHaveLength(6);
  });

  it("reports a semantic conflict when two branches update the same node", () => {
    const baseVersion = nextId();
    const branchAVersion = nextId();
    const branchBVersion = nextId();
    const nodeId = nextId();

    const baseIntent = makeIntent(baseVersion, "Base");
    const baseIntentRec = intentRecord(baseIntent);
    const baseOp = opRecord(
      baseVersion,
      { op: "node.add", node: makeNode(nodeId, "BaseNode") },
      [baseIntentRec.id],
    );
    const baseDecision = decisionRecord(
      baseVersion,
      "approved",
      diffHashForVersion(baseIntent, [baseOp], []),
      [baseOp.id],
    );
    const baseRecords = [baseIntentRec, baseOp, baseDecision];
    const baseSnapshot = foldWal(baseRecords).snapshot;
    const baseNode = baseSnapshot.nodes[nodeId];
    expect(baseNode).toBeDefined();
    const beforeHash = hashNodeForWrite(baseNode as NonNullable<typeof baseNode>);

    const intentA = makeIntent(branchAVersion, "Change A");
    const intentARec = intentRecord(intentA, [baseDecision.id]);
    const opA = opRecord(
      branchAVersion,
      {
        op: "node.update",
        id: nodeId,
        patch: { name: "NodeA" },
        beforeHash,
      },
      [intentARec.id],
    );
    const decisionA = decisionRecord(
      branchAVersion,
      "approved",
      diffHashForVersion(intentA, [opA], []),
      [opA.id],
    );

    const intentB = makeIntent(branchBVersion, "Change B");
    const intentBRec = intentRecord(intentB, [baseDecision.id]);
    const opB = opRecord(
      branchBVersion,
      {
        op: "node.update",
        id: nodeId,
        patch: { name: "NodeB" },
        beforeHash,
      },
      [intentBRec.id],
    );
    const decisionB = decisionRecord(
      branchBVersion,
      "approved",
      diffHashForVersion(intentB, [opB], []),
      [opB.id],
    );

    const merged = mergeWalRecords(
      baseRecords,
      [intentARec, opA, decisionA],
      [intentBRec, opB, decisionB],
    );

    expect(
      merged.conflicts.some((conflict) => conflict.code === "stale-write"),
    ).toBe(true);
    expect(merged.snapshot.versions[branchBVersion]?.status).toBe("conflicted");
    expect(merged.snapshot.nodes[nodeId]?.name).toBe("NodeA");
  });
});

describe("WAL IO", () => {
  it("round-trips records through append and load with atomic rewrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "jin-wal-"));
    const path = join(dir, ".jin", "wal.jsonl");
    try {
      const versionId = nextId();
      const nodeId = nextId();
      const intent = makeIntent(versionId, "IO");
      const intentRec = intentRecord(intent);
      const op = opRecord(
        versionId,
        { op: "node.add", node: makeNode(nodeId, "IONode") },
        [intentRec.id],
      );
      const decision = decisionRecord(
        versionId,
        "approved",
        diffHashForVersion(intent, [op], []),
        [op.id],
      );

      appendRecord(path, intentRec);
      appendRecord(path, op);
      appendRecord(path, decision);

      const loaded = loadWal(path);
      expect(loaded.errors).toEqual([]);
      expect(loaded.records).toHaveLength(3);
      expect(loaded.records[0]?.hash).toBe(intentRec.hash);

      writeWalAtomic(path, [intentRec, op, decision]);
      const rewritten = loadWal(path);
      expect(rewritten.errors).toEqual([]);
      expect(rewritten.records).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
