import type { DatabaseSync } from "node:sqlite";
import { blobToVector, ftsQuery, tokenize, vectorToBlob } from "./tokens";

export interface PersistedRagDoc {
  path: string;
  title: string;
  symbols: string;
  responsibility: string;
  text: string;
  nodeId: string | null;
  vector: Float32Array;
  updatedAt: string;
  sourceMtimeMs: number;
  sourceSize: number;
  architectureText: string;
}

interface RagDocRow {
  path: string;
  title: string;
  symbols: string;
  responsibility: string;
  text: string;
  node_id: string | null;
  vector: Uint8Array;
  source_mtime_ms: number;
  source_size: number;
  architecture_text: string;
}

/**
 * Durable, disposable RAG cache: document text, architecture metadata, dense
 * vectors and a custom-token FTS5 shadow table. Every row is derived from the
 * repo and can be rebuilt by the next scan.
 */
export class RagStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM rag_docs").get() as
      | { count: number }
      | undefined;
    return Number(row?.count ?? 0);
  }

  syncChanged(docs: readonly PersistedRagDoc[], deletedPaths: readonly string[]): void {
    if (docs.length === 0 && deletedPaths.length === 0) return;
    const upsertDoc = this.db.prepare(`
      INSERT INTO rag_docs(path, title, symbols, responsibility, text, node_id, vector, updated_at, source_mtime_ms, source_size, architecture_text)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title=excluded.title,
        symbols=excluded.symbols,
        responsibility=excluded.responsibility,
        text=excluded.text,
        node_id=excluded.node_id,
        vector=excluded.vector,
        updated_at=excluded.updated_at,
        source_mtime_ms=excluded.source_mtime_ms,
        source_size=excluded.source_size,
        architecture_text=excluded.architecture_text
    `);
    const insertFts = this.db.prepare("INSERT INTO rag_fts(path, tokens) VALUES(?, ?)");
    const deleteDoc = this.db.prepare("DELETE FROM rag_docs WHERE path=?");
    const deleteFts = this.db.prepare("DELETE FROM rag_fts WHERE path=?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const path of deletedPaths) {
        deleteFts.run(path);
        deleteDoc.run(path);
      }
      for (const doc of docs) {
        deleteFts.run(doc.path);
        upsertDoc.run(
          doc.path,
          doc.title,
          doc.symbols,
          doc.responsibility,
          doc.text,
          doc.nodeId,
          vectorToBlob(doc.vector),
          doc.updatedAt,
          doc.sourceMtimeMs,
          doc.sourceSize,
          doc.architectureText,
        );
        insertFts.run(
          doc.path,
          tokenize(
            `${doc.path}\n${doc.title}\n${doc.symbols}\n${doc.responsibility}\n${doc.text}`,
          ).join(" "),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  loadAll(): PersistedRagDoc[] {
    const rows = this.db
      .prepare(
        "SELECT path, title, symbols, responsibility, text, node_id, vector, source_mtime_ms, source_size, architecture_text FROM rag_docs ORDER BY path",
      )
      .all() as unknown as RagDocRow[];
    return rows.map((row) => ({
      path: row.path,
      title: row.title,
      symbols: row.symbols,
      responsibility: row.responsibility,
      text: row.text,
      nodeId: row.node_id,
      vector: blobToVector(row.vector),
      updatedAt: new Date().toISOString(),
      sourceMtimeMs: Number(row.source_mtime_ms ?? 0),
      sourceSize: Number(row.source_size ?? 0),
      architectureText: row.architecture_text ?? "",
    }));
  }

  /**
   * Candidate paths from FTS5. The caller still computes lexical/vector scores;
   * this is a cheap high-recall prefilter and proves the persisted index works.
   */
  searchPaths(query: string, limit = 64): string[] {
    const expression = ftsQuery(query);
    if (!expression) return [];
    try {
      const rows = this.db
        .prepare(
          "SELECT path FROM rag_fts WHERE rag_fts MATCH ? ORDER BY bm25(rag_fts) LIMIT ?",
        )
        .all(expression, limit) as unknown as Array<{ path: string }>;
      return rows.map((row) => row.path);
    } catch {
      return [];
    }
  }
}
