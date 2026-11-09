import { readFileSync } from "node:fs";
import type {
  WalConflict,
  WalMergeResult,
  WalParseError,
  WalRecord,
} from "../../../shared/ledger/types";
import { foldWal } from "./fold";
import { orderRecords } from "./order";
import { parseWalText, serializeWal, writeWalAtomic } from "./io";
import { emptySnapshot } from "../arch/snapshot";

const FATAL_CODES = new Set<WalConflict["code"]>([
  "duplicate-id",
  "missing-parent",
  "cycle",
]);

function fatalConflicts(conflicts: readonly WalConflict[]): WalConflict[] {
  return conflicts.filter((conflict) => FATAL_CODES.has(conflict.code));
}

/**
 * Merge three record sets (Git base/ours/theirs). The result is a deterministic
 * union in causal order. Semantic write conflicts are reported but the union is
 * still valid; the app turns them into a merge intent.
 */
export function mergeWalRecords(
  base: readonly WalRecord[],
  ours: readonly WalRecord[],
  theirs: readonly WalRecord[],
): WalMergeResult {
  const ordered = orderRecords([...base, ...ours, ...theirs]);
  const folded = foldWal(ordered.records);
  const fatal = fatalConflicts(ordered.conflicts);
  return {
    ...folded,
    text: fatal.length > 0 ? "" : serializeWal(ordered.records),
    records: ordered.records,
    parseErrors: [],
  };
}

/** Parse three JSONL files and merge them. */
export function mergeWalTexts(
  baseText: string,
  oursText: string,
  theirsText: string,
): WalMergeResult {
  const base = parseWalText(baseText);
  const ours = parseWalText(oursText);
  const theirs = parseWalText(theirsText);
  const parseErrors: WalParseError[] = [
    ...base.errors,
    ...ours.errors,
    ...theirs.errors,
  ];
  if (parseErrors.length > 0) {
    return {
      snapshot: emptySnapshot(),
      conflicts: [],
      warnings: [],
      text: "",
      records: [],
      parseErrors,
    };
  }
  return mergeWalRecords(base.records, ours.records, theirs.records);
}

/**
 * Git merge driver entry point. Writes the merged union to `outPath` (ours by
 * default) and returns the result. Semantic conflicts do not block the write;
 * the desktop app resolves them. Parse/order corruption does block it.
 */
export function mergeWalFiles(
  basePath: string,
  oursPath: string,
  theirsPath: string,
  outPath = oursPath,
): WalMergeResult {
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return "";
      }
      throw error;
    }
  };
  const result = mergeWalTexts(read(basePath), read(oursPath), read(theirsPath));
  const fatal = fatalConflicts(result.conflicts);
  if (result.parseErrors.length > 0 || fatal.length > 0) {
    const details = [
      ...result.parseErrors.map((error) => `line ${error.line}: ${error.message}`),
      ...fatal.map((conflict) => conflict.message),
    ].join("; ");
    throw new Error(`Cannot merge WAL safely: ${details}`);
  }
  writeWalAtomic(outPath, result.records);
  return result;
}
