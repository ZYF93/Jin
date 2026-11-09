import type { WalRecord } from "../../../shared/ledger/types";
import type { VersionReplay } from "../../../shared/ipc";
import { diffSnapshots } from "../arch/diff";
import { previewOps } from "../arch/preview";
import {
  applyIntent,
  applyTouch,
  diffHashForVersion,
  hashSnapshot,
} from "../arch/snapshot";
import { foldWal } from "./fold";
import { orderRecords } from "./order";

function compareRecords(a: WalRecord, b: WalRecord): number {
  if (a.hlc === b.hlc) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.hlc < b.hlc ? -1 : 1;
}

function ancestorClosure(
  byId: ReadonlyMap<string, WalRecord>,
  seeds: readonly string[],
  warnings: string[],
): Set<string> {
  const seen = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const record = byId.get(id);
    if (!record) {
      warnings.push(`Replay is missing WAL record ${id}`);
      continue;
    }
    for (const parent of record.parents) stack.push(parent);
  }
  return seen;
}

function subset(records: readonly WalRecord[], ids: ReadonlySet<string>): WalRecord[] {
  return records.filter((record) => ids.has(record.id));
}

/**
 * Reconstruct one version for read-only history.
 *
 * The base snapshot is the fold of the intent record's causal ancestors. The
 * reviewed target is rebuilt by applying that version's ops, intent and touches
 * to a clone of the base, so a rejected or conflicted version still shows the
 * exact graph its reviewer saw. Using parents instead of an HLC cutoff keeps
 * merged branches intact: a version never loses an ancestor just because two
 * actors' wall clocks disagree.
 */
export function replayVersion(
  records: readonly WalRecord[],
  versionId: string,
): VersionReplay {
  const ordered = orderRecords(records);
  const fatal = ordered.conflicts.some(
    (conflict) =>
      conflict.code === "duplicate-id" ||
      conflict.code === "missing-parent" ||
      conflict.code === "cycle",
  );
  if (fatal) {
    throw new Error(
      `Cannot replay ${versionId}: ${ordered.conflicts.map((conflict) => conflict.message).join("; ")}`,
    );
  }

  const byId = new Map(ordered.records.map((record) => [record.id, record] as const));
  const intentRecord = ordered.records.find(
    (record) => record.t === "intent" && record.versionId === versionId,
  );
  if (!intentRecord || intentRecord.t !== "intent") {
    throw new Error(`Cannot replay ${versionId}: no intent record exists.`);
  }
  const intent = intentRecord.payload;
  const versionRecords = ordered.records
    .filter((record) => record.versionId === versionId)
    .sort(compareRecords);
  const opRecords = versionRecords.filter((record) => record.t === "op");
  const touchRecords = versionRecords.filter((record) => record.t === "touch");
  const decisionRecords = versionRecords.filter((record) => record.t === "decision");

  const full = foldWal(ordered.records);
  const version = full.snapshot.versions[versionId];
  if (!version) {
    throw new Error(`Cannot replay ${versionId}: the WAL fold did not produce a version.`);
  }
  const warnings = [...full.warnings];

  const baseIds = ancestorClosure(byId, intentRecord.parents, warnings);
  const baseFolded = foldWal(subset(ordered.records, baseIds));
  warnings.push(...baseFolded.warnings);
  warnings.push(...baseFolded.conflicts.map((conflict) => conflict.message));
  const baseSnapshot = baseFolded.snapshot;

  const preview = previewOps(
    baseSnapshot,
    opRecords.map((record) => record.payload),
    versionId,
  );
  warnings.push(...preview.conflicts);
  const targetSnapshot = preview.snapshot;
  const intentConflicts = applyIntent(targetSnapshot, intent);
  warnings.push(...intentConflicts.map((conflict) => conflict.message));
  for (const record of touchRecords) {
    if (record.t !== "touch") continue;
    const conflict = applyTouch(targetSnapshot, record.payload);
    if (conflict) warnings.push(conflict.message);
  }

  const decision = decisionRecords[0]?.payload ?? null;
  if (decisionRecords.length > 1) {
    warnings.push(
      `Version ${versionId}: ${decisionRecords.length} decisions found; replay uses the earliest`,
    );
  }

  const baseHash = hashSnapshot(baseSnapshot);
  const targetHash = hashSnapshot(targetSnapshot);
  const diffHash = diffHashForVersion(intent, opRecords, touchRecords);
  if (decision) {
    if (decision.baseHash !== baseHash) {
      warnings.push("The approval base hash does not match the reconstructed base snapshot.");
    }
    if (decision.targetHash !== targetHash) {
      // A rejected decision is allowed to bind the unchanged base as its
      // "target"; only an approval promises that the proposed graph was applied.
      if (decision.decision === "approved") {
        warnings.push(
          "The approval target hash does not match the reconstructed target snapshot.",
        );
      }
    }
    if (decision.diffHash && decision.diffHash !== diffHash) {
      warnings.push("The approval diff hash does not match the reconstructed change set.");
    }
  }

  return {
    versionId,
    ordinal: version.ordinal,
    status: version.status,
    intent,
    decision,
    baseSnapshot,
    targetSnapshot,
    diff: diffSnapshots(baseSnapshot, targetSnapshot),
    baseHash,
    targetHash,
    diffHash,
    applied: ["approved", "implemented", "verified"].includes(version.status),
    warnings,
  };
}
