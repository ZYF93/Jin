import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArchSnapshot } from "../../../shared/arch/types";
import { hashSnapshot } from "../arch/snapshot";

export const INDEX_SCHEMA_VERSION = 2;

export interface IndexMeta {
  schemaVersion: number;
  recordCount: number;
  lastRecordId: string | null;
  snapshotHash: string | null;
  updatedAt: string | null;
}

/**
 * Open the disposable project index. Everything in it can be rebuilt from
 * `.jin/wal.jsonl`; it is never the source of truth.
 */
export function openSqlite(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  initializeSchema(db);
  return db;
}

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      tasks TEXT NOT NULL,
      node_intents TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      ordinal INTEGER,
      ops TEXT NOT NULL,
      touches TEXT NOT NULL,
      decisions TEXT NOT NULL,
      implementations TEXT NOT NULL,
      base_hash TEXT,
      target_hash TEXT,
      diff_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_id TEXT,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      file TEXT NOT NULL,
      symbol TEXT NOT NULL,
      responsibility TEXT NOT NULL,
      intent_id TEXT,
      status TEXT NOT NULL,
      metadata TEXT NOT NULL,
      introduced_in TEXT NOT NULL,
      updated_in TEXT NOT NULL,
      last_touched_in TEXT
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      metadata TEXT NOT NULL,
      introduced_in TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS touches (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      facet_id TEXT,
      reason TEXT NOT NULL,
      code_refs TEXT NOT NULL,
      tests TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      by_actor TEXT NOT NULL,
      note TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      diff_hash TEXT,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS implementations (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      git_commit TEXT NOT NULL,
      files TEXT NOT NULL,
      checks TEXT NOT NULL,
      conformance TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
      node_id UNINDEXED,
      name,
      path,
      responsibility,
      intent_text,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS rag_docs (
      path TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      symbols TEXT NOT NULL,
      responsibility TEXT NOT NULL,
      text TEXT NOT NULL,
      node_id TEXT,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
      path UNINDEXED,
      tokens,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS lsp_symbols (
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      character INTEGER NOT NULL,
      detail TEXT NOT NULL,
      PRIMARY KEY(path, name, line, character)
    );

    CREATE TABLE IF NOT EXISTS lsp_diagnostics (
      path TEXT NOT NULL,
      line INTEGER NOT NULL,
      character INTEGER NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      source TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lsp_symbols_path ON lsp_symbols(path);
    CREATE INDEX IF NOT EXISTS idx_lsp_diagnostics_path ON lsp_diagnostics(path);
    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_level ON nodes(level);
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
    CREATE INDEX IF NOT EXISTS idx_versions_status ON versions(status);
  `);

  db.prepare(
    "INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', ?)",
  ).run(String(INDEX_SCHEMA_VERSION));
}

function intentTextByNode(snapshot: ArchSnapshot): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const intent of Object.values(snapshot.intents)) {
    for (const nodeIntent of intent.nodeIntents) {
      const id = nodeIntent.facetId ?? nodeIntent.nodeId;
      const list = result.get(id);
      if (list) list.push(nodeIntent.statement);
      else result.set(id, [nodeIntent.statement]);
    }
  }
  return result;
}

/**
 * Materialize a folded snapshot. v1 writes a consistent whole-snapshot
 * transaction; it is intentionally rebuildable and boring. Record-level
 * incremental refresh can be added without changing any query surface.
 */
export function materializeSnapshot(
  db: DatabaseSync,
  snapshot: ArchSnapshot,
): void {
  const setMeta = db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const insertIntent = db.prepare(`
    INSERT INTO intents(id, version_id, title, goal, tasks, node_intents, author, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVersion = db.prepare(`
    INSERT INTO versions(id, intent_id, status, ordinal, ops, touches, decisions, implementations, base_hash, target_hash, diff_hash, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertNode = db.prepare(`
    INSERT INTO nodes(id, level, kind, parent_id, name, path, file, symbol, responsibility, intent_id, status, metadata, introduced_in, updated_in, last_touched_in)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEdge = db.prepare(`
    INSERT INTO edges(id, from_id, to_id, kind, metadata, introduced_in)
    VALUES(?, ?, ?, ?, ?, ?)
  `);
  const insertTouch = db.prepare(`
    INSERT INTO touches(id, version_id, intent_id, node_id, facet_id, reason, code_refs, tests, actor, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDecision = db.prepare(`
    INSERT INTO decisions(id, version_id, decision, by_actor, note, base_hash, target_hash, diff_hash, signature, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertImplementation = db.prepare(`
    INSERT INTO implementations(id, version_id, git_commit, files, checks, conformance, actor, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO node_fts(node_id, name, path, responsibility, intent_text)
    VALUES(?, ?, ?, ?, ?)
  `);

  const ftsText = intentTextByNode(snapshot);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [
      "node_fts",
      "edges",
      "nodes",
      "versions",
      "touches",
      "decisions",
      "implementations",
      "intents",
    ]) {
      db.exec(`DELETE FROM ${table}`);
    }

    for (const intent of Object.values(snapshot.intents)) {
      insertIntent.run(
        intent.id,
        intent.versionId,
        intent.title,
        intent.goal,
        JSON.stringify(intent.tasks),
        JSON.stringify(intent.nodeIntents),
        JSON.stringify(intent.author),
        intent.createdAt,
      );
    }

    for (const version of Object.values(snapshot.versions)) {
      insertVersion.run(
        version.id,
        version.intentId,
        version.status,
        version.ordinal,
        JSON.stringify(version.ops),
        JSON.stringify(version.touches),
        JSON.stringify(version.decisions),
        JSON.stringify(version.implementations),
        version.baseHash,
        version.targetHash,
        version.diffHash,
        version.createdAt,
        version.updatedAt,
      );
    }

    for (const node of Object.values(snapshot.nodes)) {
      insertNode.run(
        node.id,
        node.level,
        node.kind,
        node.parentId,
        node.name,
        node.path,
        node.file,
        node.symbol,
        node.responsibility,
        node.intentId,
        node.status,
        JSON.stringify(node.metadata),
        node.introducedIn,
        node.updatedIn,
        node.lastTouchedIn,
      );
      insertFts.run(
        node.id,
        node.name,
        node.path,
        node.responsibility,
        (ftsText.get(node.id) ?? []).join("\n"),
      );
    }

    for (const edge of Object.values(snapshot.edges)) {
      insertEdge.run(
        edge.id,
        edge.from,
        edge.to,
        edge.kind,
        JSON.stringify(edge.metadata),
        edge.introducedIn,
      );
    }

    for (const touch of Object.values(snapshot.touches)) {
      insertTouch.run(
        touch.id,
        touch.versionId,
        touch.intentId,
        touch.nodeId,
        touch.facetId,
        touch.reason,
        JSON.stringify(touch.codeRefs),
        JSON.stringify(touch.tests),
        JSON.stringify(touch.actor),
        touch.createdAt,
      );
    }

    for (const decision of Object.values(snapshot.decisions)) {
      insertDecision.run(
        decision.id,
        decision.versionId,
        decision.decision,
        JSON.stringify(decision.by),
        decision.note,
        decision.baseHash,
        decision.targetHash,
        decision.diffHash ?? null,
        decision.signature,
        decision.createdAt,
      );
    }

    for (const implementation of Object.values(snapshot.implementations)) {
      insertImplementation.run(
        implementation.id,
        implementation.versionId,
        implementation.gitCommit,
        JSON.stringify(implementation.files),
        JSON.stringify(implementation.checks),
        JSON.stringify(implementation.conformance),
        JSON.stringify(implementation.actor),
        implementation.createdAt,
      );
    }

    setMeta.run("schema_version", String(INDEX_SCHEMA_VERSION));
    setMeta.run("record_count", String(snapshot.recordCount));
    setMeta.run("last_record_id", snapshot.lastRecordId ?? "");
    setMeta.run("snapshot_hash", hashSnapshot(snapshot));
    setMeta.run("updated_at", new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readIndexMeta(db: DatabaseSync): IndexMeta {
  const rows = db
    .prepare("SELECT key, value FROM meta")
    .all() as unknown as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    schemaVersion: Number(values.get("schema_version") ?? 0),
    recordCount: Number(values.get("record_count") ?? 0),
    lastRecordId: values.get("last_record_id") || null,
    snapshotHash: values.get("snapshot_hash") || null,
    updatedAt: values.get("updated_at") || null,
  };
}
