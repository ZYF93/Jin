import type { WalRecord } from "../../../shared/wal/types";

/**
 * Return the current causal frontier. A linear log has one head; a merged log
 * can have several. New records should name every head as a parent so no branch
 * is accidentally orphaned.
 */
export function walHeads(records: readonly WalRecord[]): string[] {
  const ids = new Set(records.map((record) => record.id));
  const referenced = new Set<string>();
  for (const record of records) {
    for (const parent of record.parents) {
      if (ids.has(parent)) referenced.add(parent);
    }
  }
  return records
    .filter((record) => !referenced.has(record.id))
    .map((record) => record.id)
    .sort();
}
