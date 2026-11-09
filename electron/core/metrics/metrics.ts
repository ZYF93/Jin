import type {
  ApprovalMetrics,
  DriftMetrics,
  ProjectMetrics,
  ReuseMetrics,
  UsageMetrics,
} from "../../../shared/ipc";
import type { ArchSnapshot } from "../../../shared/ledger/types";
import {
  hasFailedDrift,
  latestImplementation,
} from "../../../shared/arch/conformance";

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Math.round(sorted[middle] ?? 0);
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/** Intent creation → first approval. A non-monotonic clock is ignored, not guessed. */
function approvalMetrics(snapshot: ArchSnapshot): ApprovalMetrics {
  const durations: number[] = [];
  for (const version of Object.values(snapshot.versions)) {
    const intent = snapshot.intents[version.intentId];
    if (!intent) continue;
    const created = Date.parse(intent.createdAt);
    const decisions = version.decisions
      .map((id) => snapshot.decisions[id])
      .filter((decision) => decision?.decision === "approved")
      .map((decision) => Date.parse(decision?.createdAt ?? ""))
      .filter((time) => Number.isFinite(time))
      .sort((left, right) => left - right);
    const decided = decisions[0];
    if (!Number.isFinite(created) || decided === undefined) continue;
    const duration = decided - created;
    if (duration < 0) continue;
    durations.push(duration);
  }
  if (durations.length === 0) {
    return { count: 0, averageMs: null, medianMs: null };
  }
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    count: durations.length,
    averageMs: Math.round(total / durations.length),
    medianMs: median(durations),
  };
}

function driftMetrics(snapshot: ArchSnapshot): DriftMetrics {
  let implemented = 0;
  let drifted = 0;
  for (const version of Object.values(snapshot.versions)) {
    const implementation = latestImplementation(snapshot, version);
    if (!implementation) continue;
    implemented += 1;
    if (hasFailedDrift(implementation)) drifted += 1;
  }
  return {
    implemented,
    drifted,
    rate: implemented > 0 ? drifted / implemented : null,
  };
}

function reuseMetrics(snapshot: ArchSnapshot): ReuseMetrics {
  let passed = 0;
  let skipped = 0;
  let failed = 0;
  for (const version of Object.values(snapshot.versions)) {
    const implementation = latestImplementation(snapshot, version);
    const check = implementation?.checks.find(
      (candidate) => candidate.name.toLowerCase() === "reuse",
    );
    if (!check) continue;
    if (check.status === "pass") passed += 1;
    else if (check.status === "fail") failed += 1;
    else skipped += 1;
  }
  const applicable = passed + failed;
  return {
    applicable,
    passed,
    skipped,
    failed,
    rate: applicable > 0 ? passed / applicable : null,
  }
}

/**
 * Project-level delivery metrics derived from the ledger plus the local usage
 * cache. Everything except provider tokens is reproducible from the WAL, so a
 * teammate opening the same repository sees the same approval/drift/reuse
 * numbers.
 */
export function computeProjectMetrics(
  snapshot: ArchSnapshot,
  usage: UsageMetrics,
): ProjectMetrics {
  return {
    approval: approvalMetrics(snapshot),
    drift: driftMetrics(snapshot),
    reuse: reuseMetrics(snapshot),
    usage,
  };
}
