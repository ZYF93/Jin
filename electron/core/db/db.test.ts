import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type {
  Actor,
  ArchNodeDraft,
  Intent,
} from "../../../shared/arch/types";
import type { WalRecord } from "../../../shared/wal/types";
import {
  diffHashForVersion,
  emptySnapshot,
  hashSnapshot,
} from "../arch/snapshot";
import { ulid } from "../ids/ulid";
import { walPath } from "../project/config";
import { initProject } from "../project/init";
import { formatHlc } from "../time/hlc";
import { writeWalAtomic } from "../wal/io";
import { sealRecord } from "../wal/record";
import {
  closeAppDatabase,
  getSetting,
  listRecentProjects,
  openAppDatabase,
  recordRecentProject,
  setSetting,
} from "./app-db";
import { openJinIndex } from "./jin-index";
import { INDEX_SCHEMA_VERSION } from "./schema";

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
  return formatHlc({ wall: BASE_TIME + hlcCounter, counter: 0, actor: "test" });
}

function nodeDraft(id: string, name: string): ArchNodeDraft {
  return {
    id,
    level: "L1",
    kind: "component",
    parentId: null,
    name,
    path: `src/${name}`,
    file: `src/${name}.tsx`,
    symbol: name,
    responsibility: `${name} responsibility`,
    intentId: null,
    status: "active",
    metadata: {},
  };
}

interface VersionFixture {
  records: WalRecord[];
  versionId: string;
  nodeId: string;
  decisionId: string;
}

function addNodeVersion(name: string, parents: string[] = []): VersionFixture {
  const versionId = nextId();
  const nodeId = nextId();
  const intent: Intent = {
    id: nextId(),
    versionId,
    title: `Add ${name}`,
    goal: `Create ${name}`,
    tasks: [],
    nodeIntents: [],
    author: ACTOR,
    createdAt: new Date(BASE_TIME + idCounter).toISOString(),
  };
  const intentRec = sealRecord({
    t: "intent",
    id: nextId(),
    versionId,
    actor: ACTOR,
    hlc: nextHlc(),
    parents,
    payload: intent,
  });
  const op = sealRecord({
    t: "op",
    id: nextId(),
    versionId,
    actor: ACTOR,
    hlc: nextHlc(),
    parents: [intentRec.id],
    payload: { op: "node.add", node: nodeDraft(nodeId, name) },
  });
  const emptyHash = hashSnapshot(emptySnapshot());
  const decision = sealRecord({
    t: "decision",
    id: nextId(),
    versionId,
    actor: ACTOR,
    hlc: nextHlc(),
    parents: [op.id],
    payload: {
      id: nextId(),
      versionId,
      decision: "approved",
      by: ACTOR,
      note: "",
      baseHash: emptyHash,
      targetHash: emptyHash,
      diffHash: diffHashForVersion(intent, [op], []),
      signature: "test",
      createdAt: new Date(BASE_TIME + idCounter).toISOString(),
    },
  });
  return {
    records: [intentRec, op, decision],
    versionId,
    nodeId,
    decisionId: decision.id,
  };
}

describe("JinIndex", () => {
  it("rebuilds from WAL, exposes FTS, and refreshes after append", () => {
    const root = mkdtempSync(join(tmpdir(), "jin-index-"));
    try {
      initProject(root, { name: "Index Test" });
      const first = addNodeVersion("ChatPanel");
      writeWalAtomic(walPath(root), first.records);

      const index = openJinIndex(root);
      try {
        const folded = index.rebuildFromWal();
        expect(folded.snapshot.nodes[first.nodeId]?.name).toBe("ChatPanel");

        const count = index.db
          .prepare("SELECT COUNT(*) AS count FROM nodes")
          .get() as unknown as { count: number };
        expect(count.count).toBe(1);

        const fts = index.db
          .prepare("SELECT node_id FROM node_fts WHERE node_fts MATCH ?")
          .all("ChatPanel") as unknown as Array<{ node_id: string }>;
        expect(fts[0]?.node_id).toBe(first.nodeId);

        const meta = index.meta();
        expect(meta.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
        expect(meta.recordCount).toBe(3);
        expect(meta.lastRecordId).toBe(first.decisionId);
        expect(meta.snapshotHash).toBe(hashSnapshot(folded.snapshot));

        expect(index.refreshFromWal()).toBeNull();

        const second = addNodeVersion("SecondNode", [first.decisionId]);
        writeWalAtomic(walPath(root), [...first.records, ...second.records]);
        const refreshed = index.refreshFromWal();
        expect(refreshed).not.toBeNull();
        expect(index.meta().recordCount).toBe(6);

        const countAfter = index.db
          .prepare("SELECT COUNT(*) AS count FROM nodes")
          .get() as unknown as { count: number };
        expect(countAfter.count).toBe(2);
        const ftsAfter = index.db
          .prepare("SELECT node_id FROM node_fts WHERE node_fts MATCH ?")
          .all("SecondNode") as unknown as Array<{ node_id: string }>;
        expect(ftsAfter[0]?.node_id).toBe(second.nodeId);
      } finally {
        index.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("app database", () => {
  it("upserts recent projects and settings", () => {
    const root = mkdtempSync(join(tmpdir(), "jin-app-db-"));
    const app = openAppDatabase(join(root, "jin.db"));
    try {
      recordRecentProject(app, {
        path: "/repo/a",
        name: "A",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
      });
      recordRecentProject(app, {
        path: "/repo/b",
        name: "B",
        lastOpenedAt: "2026-01-02T00:00:00.000Z",
      });
      recordRecentProject(app, {
        path: "/repo/a",
        name: "A2",
        lastOpenedAt: "2026-01-03T00:00:00.000Z",
      });

      const recent = listRecentProjects(app);
      expect(recent).toHaveLength(2);
      expect(recent[0]?.path).toBe("/repo/a");
      expect(recent[0]?.name).toBe("A2");

      setSetting(app, "theme", "dark");
      expect(getSetting(app, "theme")).toBe("dark");
      setSetting(app, "theme", "light");
      expect(getSetting(app, "theme")).toBe("light");
      expect(getSetting(app, "missing")).toBeNull();
    } finally {
      closeAppDatabase(app);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
