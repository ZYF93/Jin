import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  FoldResult,
  WalConflict,
  WalConflictCode,
} from "../../../shared/arch/types";
import type { WalRecord } from "../../../shared/wal/types";
import { foldWal } from "../wal/fold";
import { loadWal } from "../wal/io";
import { cachePath, walPath } from "../project/config";
import {
  materializeSnapshot,
  openSqlite,
  readIndexMeta,
  type IndexMeta,
} from "./schema";

const FATAL_CODES: ReadonlySet<WalConflictCode> = new Set<WalConflictCode>([
  "duplicate-id",
  "missing-parent",
  "cycle",
]);

function fatalConflicts(conflicts: readonly WalConflict[]): WalConflict[] {
  return conflicts.filter((conflict) => FATAL_CODES.has(conflict.code));
}

/**
 * The project-local materialized index. It owns no authority: if deleted, the
 * next `rebuildFromWal` recreates it.
 */
export class JinIndex {
  readonly root: string;
  readonly path: string;
  readonly db: DatabaseSync;

  constructor(root: string) {
    this.root = root;
    this.path = join(cachePath(root), "index.db");
    this.db = openSqlite(this.path);
  }

  rebuild(records: readonly WalRecord[]): FoldResult {
    const result = foldWal(records);
    const fatal = fatalConflicts(result.conflicts);
    if (fatal.length > 0) {
      throw new Error(
        `Cannot index a corrupt WAL: ${fatal.map((conflict) => conflict.message).join("; ")}`,
      );
    }
    materializeSnapshot(this.db, result.snapshot);
    return result;
  }

  rebuildFromWal(path = walPath(this.root)): FoldResult {
    const loaded = loadWal(path);
    if (loaded.errors.length > 0) {
      throw new Error(
        `Cannot index WAL: ${loaded.errors
          .map((error) => `line ${error.line}: ${error.message}`)
          .join("; ")}`,
      );
    }
    return this.rebuild(loaded.records);
  }

  /**
   * Coarse refresh after append/pull. It skips unchanged files; when the log
   * changed it folds once and rewrites the materialized tables in one
   * transaction. Record-level apply belongs to the file-watcher milestone.
   */
  refreshFromWal(path = walPath(this.root)): FoldResult | null {
    const loaded = loadWal(path);
    if (loaded.errors.length > 0) {
      throw new Error(
        `Cannot refresh WAL: ${loaded.errors
          .map((error) => `line ${error.line}: ${error.message}`)
          .join("; ")}`,
      );
    }
    const last = loaded.records[loaded.records.length - 1]?.id ?? null;
    const meta = this.meta();
    if (
      meta.recordCount === loaded.records.length &&
      meta.lastRecordId === last
    ) {
      return null;
    }
    return this.rebuild(loaded.records);
  }

  meta(): IndexMeta {
    return readIndexMeta(this.db);
  }

  close(): void {
    this.db.close();
  }
}

export function openJinIndex(root: string): JinIndex {
  return new JinIndex(root);
}
