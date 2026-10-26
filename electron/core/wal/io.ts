import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type {
  WalParseResult,
  WalRecord,
} from "../../../shared/wal/types";
import {
  parseRecordLine,
  serializeRecord,
  validateRecord,
} from "./record";

/** Parse a JSONL WAL, collecting per-line errors instead of failing the file. */
export function parseWalText(text: string): WalParseResult {
  const records: WalRecord[] = [];
  const errors: WalParseResult["errors"] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    try {
      records.push(parseRecordLine(line, index + 1));
    } catch (error) {
      errors.push({
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { records, errors };
}

export function readWalText(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

export function loadWal(path: string): WalParseResult {
  return parseWalText(readWalText(path));
}

/**
 * Append one record with a single write + fsync. The WAL is append-only; Git
 * merge drivers are the only writers allowed to rewrite the file.
 */
export function appendRecord(path: string, record: WalRecord): void {
  const issues = validateRecord(record);
  if (issues.length > 0) {
    throw new Error(`Refusing to append invalid WAL record: ${issues.join("; ")}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o644);
  try {
    writeSync(fd, `${serializeRecord(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function serializeWal(records: readonly WalRecord[]): string {
  if (records.length === 0) return "";
  return `${records.map((record) => serializeRecord(record)).join("\n")}\n`;
}

/** Atomically replace the WAL, used by the merge driver and explicit imports. */
export function writeWalAtomic(path: string, records: readonly WalRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "w", 0o644);
  try {
    writeSync(fd, serializeWal(records));
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // best effort
    }
    throw error;
  }
  closeSync(fd);
  renameSync(temp, path);
}

/** Create an empty WAL file if it does not exist yet. */
export function ensureWalFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return;
  const fd = openSync(path, "a", 0o644);
  closeSync(fd);
}
