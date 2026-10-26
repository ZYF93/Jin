import type { WalConflict } from "../../../shared/arch/types";
import type { WalRecord } from "../../../shared/wal/types";
import { compareHlc } from "../time/hlc";

export interface OrderedRecords {
  records: WalRecord[];
  conflicts: WalConflict[];
}

function safeCompareHlc(a: string, b: string): number {
  try {
    return compareHlc(a, b);
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

/**
 * Topologically order records by `parents`, breaking ties with HLC then id.
 * Duplicate ids with identical hashes are deduplicated; conflicting duplicates,
 * missing parents, and cycles are reported.
 */
export function orderRecords(input: readonly WalRecord[]): OrderedRecords {
  const conflicts: WalConflict[] = [];
  const byId = new Map<string, WalRecord>();

  for (const record of input) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      continue;
    }
    if (existing.hash === record.hash) continue;
    conflicts.push({
      code: "duplicate-id",
      message: `Record ${record.id} appears with two different hashes`,
      recordIds: [record.id],
    });
  }

  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const record of byId.values()) {
    let degree = 0;
    for (const parentId of new Set(record.parents)) {
      if (!byId.has(parentId)) {
        conflicts.push({
          code: "missing-parent",
          message: `Record ${record.id} references missing parent ${parentId}`,
          recordIds: [record.id, parentId],
        });
        continue;
      }
      degree += 1;
      const list = children.get(parentId);
      if (list) list.push(record.id);
      else children.set(parentId, [record.id]);
    }
    indegree.set(record.id, degree);
  }

  const queue = [...byId.values()]
    .filter((record) => (indegree.get(record.id) ?? 0) === 0)
    .sort((a, b) => safeCompareHlc(a.hlc, b.hlc) || (a.id < b.id ? -1 : 1));

  const ordered: WalRecord[] = [];
  while (queue.length > 0) {
    const record = queue.shift();
    if (!record) break;
    ordered.push(record);
    for (const childId of children.get(record.id) ?? []) {
      const next = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, next);
      if (next === 0) {
        const child = byId.get(childId);
        if (child) {
          queue.push(child);
          queue.sort(
            (a, b) => safeCompareHlc(a.hlc, b.hlc) || (a.id < b.id ? -1 : 1),
          );
        }
      }
    }
  }

  if (ordered.length !== byId.size) {
    const orderedIds = new Set(ordered.map((record) => record.id));
    const remaining = [...byId.keys()].filter((id) => !orderedIds.has(id));
    conflicts.push({
      code: "cycle",
      message: `Record graph contains a cycle involving ${remaining.length} record(s)`,
      recordIds: remaining,
    });
  }

  return { records: ordered, conflicts };
}
