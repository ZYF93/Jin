import type {
  Decision,
  FoldResult,
  ImplementationRecord,
  Intent,
  WalConflict,
} from "../../../shared/arch/types";
import type {
  DecisionWalRecord,
  ImplementationWalRecord,
  IntentWalRecord,
  OpWalRecord,
  TouchWalRecord,
  WalRecord,
} from "../../../shared/wal/types";
import {
  applyDecision,
  applyImplementation,
  applyIntent,
  applyOp,
  applyTouch,
  cloneSnapshot,
  createVersionState,
  diffHashForVersion,
  emptySnapshot,
  hashSnapshot,
} from "../arch/snapshot";
import { orderRecords } from "./order";

function compareRecords(a: WalRecord, b: WalRecord): number {
  if (a.hlc === b.hlc) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.hlc < b.hlc ? -1 : 1;
}

function pushRecord<T>(
  map: Map<string, T[]>,
  key: string,
  record: T,
): void {
  const list = map.get(key);
  if (list) list.push(record);
  else map.set(key, [record]);
}

function latestImplementation(
  records: readonly ImplementationWalRecord[],
): ImplementationRecord | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort(compareRecords);
  return sorted[sorted.length - 1]?.payload ?? null;
}

function isVerified(implementation: ImplementationRecord | null): boolean {
  if (!implementation) return false;
  if (implementation.conformance.length === 0) return false;
  return (
    implementation.checks.every((check) => check.status === "pass") &&
    implementation.conformance.every((result) => result.status === "pass")
  );
}

function findDecision(
  records: readonly DecisionWalRecord[],
  warnings: string[],
  versionId: string,
): Decision | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort(compareRecords);
  if (sorted.length > 1) {
    warnings.push(
      `Version ${versionId}: ${sorted.length} decisions found; using the earliest`,
    );
  }
  return sorted[0]?.payload ?? null;
}

/**
 * Fold WAL records into the current architecture snapshot.
 *
 * Only approved/implemented/verified versions mutate nodes and edges. Draft and
 * rejected versions remain in history. Each version is applied atomically to a
 * clone; a stale write or a mismatched approval leaves the current snapshot
 * untouched and marks the version conflicted.
 */
export function foldWal(records: readonly WalRecord[]): FoldResult {
  const ordered = orderRecords(records);
  const fatalOrderConflict = ordered.conflicts.some(
    (conflict) =>
      conflict.code === "duplicate-id" ||
      conflict.code === "missing-parent" ||
      conflict.code === "cycle",
  );
  if (fatalOrderConflict) {
    return { snapshot: emptySnapshot(), conflicts: ordered.conflicts, warnings: [] };
  }

  const conflicts: WalConflict[] = [...ordered.conflicts];
  const warnings: string[] = [];
  const intentRecords = new Map<string, IntentWalRecord>();
  const intents = new Map<string, Intent>();
  const ops = new Map<string, OpWalRecord[]>();
  const touches = new Map<string, TouchWalRecord[]>();
  const decisions = new Map<string, DecisionWalRecord[]>();
  const implementations = new Map<string, ImplementationWalRecord[]>();

  // First pass: intents define versions. The intent record's HLC is the stable
  // version creation order used for the UI ordinal and apply order.
  for (const record of ordered.records) {
    if (record.t !== "intent") continue;
    const intent = record.payload;
    const existing = intents.get(record.versionId);
    if (existing) {
      if (existing.id !== intent.id) {
        conflicts.push({
          code: "invalid-version",
          message: `Version ${record.versionId} has two different intents`,
          recordIds: [record.id],
        });
      } else {
        warnings.push(`Version ${record.versionId}: duplicate intent record ignored`);
      }
      continue;
    }
    intents.set(record.versionId, intent);
    intentRecords.set(record.versionId, record);
  }

  // Second pass: group changes, rejecting records for versions without intents.
  for (const record of ordered.records) {
    if (record.t === "intent") continue;
    if (!intents.has(record.versionId)) {
      conflicts.push({
        code: "missing-intent",
        message: `Record ${record.id} references version ${record.versionId} without an intent`,
        recordIds: [record.id],
      });
      continue;
    }
    if (record.t === "op") pushRecord(ops, record.versionId, record);
    if (record.t === "touch") pushRecord(touches, record.versionId, record);
    if (record.t === "decision") pushRecord(decisions, record.versionId, record);
    if (record.t === "implementation") {
      pushRecord(implementations, record.versionId, record);
    }
  }

  for (const list of ops.values()) list.sort(compareRecords);
  for (const list of touches.values()) list.sort(compareRecords);
  for (const list of decisions.values()) list.sort(compareRecords);
  for (const list of implementations.values()) list.sort(compareRecords);

  const chosenDecisions = new Map<string, Decision | null>();
  for (const versionId of intents.keys()) {
    chosenDecisions.set(
      versionId,
      findDecision(decisions.get(versionId) ?? [], warnings, versionId),
    );
  }

  let snapshot = emptySnapshot();
  for (const [versionId, intent] of intents) {
    const version = createVersionState(intent);
    version.ops = (ops.get(versionId) ?? []).map((record) => record.id);
    version.touches = (touches.get(versionId) ?? []).map((record) => record.id);
    version.decisions = (decisions.get(versionId) ?? []).map((record) => record.id);
    version.implementations = (implementations.get(versionId) ?? []).map(
      (record) => record.id,
    );
    version.diffHash = diffHashForVersion(
      intent,
      ops.get(versionId) ?? [],
      touches.get(versionId) ?? [],
    );
    snapshot.intents[intent.id] = intent;
    snapshot.versions[versionId] = version;
  }

  // Decisions and implementations are history even for rejected versions.
  for (const [versionId, records] of decisions) {
    for (const record of records) {
      const result = applyDecision(snapshot, record.payload, record.id);
      if (result) conflicts.push({ ...result, versionId });
      const version = snapshot.versions[versionId];
      if (version) version.updatedAt = record.payload.createdAt;
    }
  }
  for (const [versionId, records] of implementations) {
    for (const record of records) {
      const result = applyImplementation(snapshot, record.payload, record.id);
      if (result) conflicts.push({ ...result, versionId });
      const version = snapshot.versions[versionId];
      if (version) version.updatedAt = record.payload.createdAt;
    }
  }

  // Derive status from decisions, then implementations.
  for (const versionId of intents.keys()) {
    const version = snapshot.versions[versionId];
    if (!version) continue;
    const decision = chosenDecisions.get(versionId) ?? null;
    if (decision) {
      version.status = decision.decision === "rejected" ? "rejected" : "approved";
    }
    if (decision?.decision === "approved") {
      const implementation = latestImplementation(
        implementations.get(versionId) ?? [],
      );
      if (implementation) {
        version.status = isVerified(implementation) ? "verified" : "implemented";
      }
    } else if (!decision && (implementations.get(versionId) ?? []).length > 0) {
      warnings.push(
        `Version ${versionId}: implementation exists without an approval`,
      );
    }
  }

  // Apply only approved versions, in intent creation order. Disjoint concurrent
  // versions can both apply; a stale write leaves the version conflicted.
  const versionIds = [...intents.keys()].sort((a, b) => {
    const left = intentRecords.get(a);
    const right = intentRecords.get(b);
    if (!left || !right) return a < b ? -1 : a > b ? 1 : 0;
    return compareRecords(left, right);
  });

  for (const versionId of versionIds) {
    const version = snapshot.versions[versionId];
    const intent = intents.get(versionId);
    if (!version || !intent) continue;
    if (!["approved", "implemented", "verified"].includes(version.status)) {
      continue;
    }

    const versionOps = ops.get(versionId) ?? [];
    const versionTouches = touches.get(versionId) ?? [];
    const decision = chosenDecisions.get(versionId) ?? null;
    const computedDiffHash = version.diffHash ?? diffHashForVersion(intent, versionOps, versionTouches);

    if (decision?.diffHash && decision.diffHash !== computedDiffHash) {
      version.status = "conflicted";
      conflicts.push({
        code: "approval-mismatch",
        message: `Version ${versionId}: approval does not match the reviewed change set`,
        versionId,
        recordIds: [
          ...(decisions.get(versionId) ?? []).map((record) => record.id),
          ...versionOps.map((record) => record.id),
          ...versionTouches.map((record) => record.id),
        ],
      });
      continue;
    }

    const next = cloneSnapshot(snapshot);
    const beforeHash = hashSnapshot(snapshot);
    const versionConflicts: WalConflict[] = [];

    for (const record of versionOps) {
      const result = applyOp(next, record.payload, versionId, record.id);
      if (result) {
        versionConflicts.push(result);
        break;
      }
    }

    if (versionConflicts.length === 0) {
      versionConflicts.push(...applyIntent(next, intent));
    }

    if (versionConflicts.length === 0) {
      for (const record of versionTouches) {
        const result = applyTouch(next, record.payload);
        if (result) {
          versionConflicts.push(result);
          break;
        }
      }
    }

    if (versionConflicts.length > 0) {
      version.status = "conflicted";
      conflicts.push(...versionConflicts.map((item) => ({ ...item, versionId })));
      continue;
    }

    const targetHash = hashSnapshot(next);
    const nextVersion = next.versions[versionId];
    if (nextVersion) {
      nextVersion.baseHash = beforeHash;
      nextVersion.targetHash = targetHash;
      nextVersion.diffHash = computedDiffHash;
    }

    if (decision) {
      if (decision.baseHash !== beforeHash) {
        warnings.push(
          `Version ${versionId}: base snapshot changed since approval (expected ${decision.baseHash}, got ${beforeHash})`,
        );
      }
      if (decision.targetHash !== targetHash) {
        warnings.push(
          `Version ${versionId}: target snapshot changed since approval (expected ${decision.targetHash}, got ${targetHash})`,
        );
      }
    }

    snapshot = next;
  }

  for (let index = 0; index < versionIds.length; index += 1) {
    const versionId = versionIds[index];
    if (!versionId) continue;
    const version = snapshot.versions[versionId];
    if (!version) continue;
    version.ordinal = index + 1;
  }

  snapshot.lastRecordId = ordered.records[ordered.records.length - 1]?.id ?? null;
  snapshot.recordCount = ordered.records.length;

  return { snapshot, conflicts, warnings };
}
