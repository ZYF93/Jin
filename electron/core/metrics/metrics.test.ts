import { describe, expect, it } from "vite-plus/test";
import type {
  Decision,
  ImplementationRecord,
  Intent,
  VersionState,
} from "../../../shared/arch/types";
import { emptySnapshot } from "../arch/snapshot";
import { computeProjectMetrics } from "./metrics";

const ACTOR = { id: "user:test", kind: "user" as const, name: "Test" };

function intent(versionId: string, createdAt: string): Intent {
  return {
    id: `intent-${versionId}`,
    versionId,
    title: `Intent ${versionId}`,
    goal: "Measure delivery.",
    tasks: [],
    nodeIntents: [],
    author: ACTOR,
    createdAt,
  };
}

function version(
  id: string,
  ordinal: number,
  status: VersionState["status"],
  intentId: string,
  decisions: string[],
  implementations: string[],
  createdAt: string,
): VersionState {
  return {
    id,
    intentId,
    status,
    ordinal,
    ops: [],
    touches: [],
    decisions,
    implementations,
    baseHash: null,
    targetHash: null,
    diffHash: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function decision(
  id: string,
  versionId: string,
  outcome: Decision["decision"],
  createdAt: string,
): Decision {
  return {
    id,
    versionId,
    decision: outcome,
    by: ACTOR,
    note: "",
    baseHash: "sha256:base",
    targetHash: "sha256:target",
    signature: "sig",
    createdAt,
  };
}

function implementation(
  id: string,
  versionId: string,
  drift: "pass" | "fail",
  reuse: "pass" | "fail" | "skip",
  createdAt: string,
): ImplementationRecord {
  return {
    id,
    versionId,
    gitCommit: "abc",
    files: [],
    checks: [{ name: "reuse", status: reuse, detail: "" }],
    conformance: [{ opId: "drift", kind: "drift", status: drift, evidence: [] }],
    actor: ACTOR,
    createdAt,
  };
}

describe("computeProjectMetrics", () => {
  it("derives approval, drift and reuse metrics from ledger history", () => {
    const snapshot = emptySnapshot();
    snapshot.intents = {
      "intent-a": intent("a", "2026-01-01T00:00:00.000Z"),
      "intent-b": intent("b", "2026-01-01T00:00:00.000Z"),
      "intent-c": intent("c", "2026-01-01T00:00:00.000Z"),
      "intent-d": intent("d", "2026-01-01T00:00:00.000Z"),
    };
    snapshot.decisions = {
      "decision-a": decision("decision-a", "a", "approved", "2026-01-01T00:02:00.000Z"),
      "decision-b": decision("decision-b", "b", "approved", "2026-01-01T00:04:00.000Z"),
      "decision-c": decision("decision-c", "c", "rejected", "2026-01-01T00:01:00.000Z"),
      "decision-d": decision("decision-d", "d", "approved", "2026-01-01T00:06:00.000Z"),
    };
    snapshot.implementations = {
      // A's older implementation failed drift, but only the latest one counts.
      "impl-a-old": implementation("impl-a-old", "a", "fail", "fail", "2026-01-01T00:03:00.000Z"),
      "impl-a": implementation("impl-a", "a", "pass", "pass", "2026-01-01T00:05:00.000Z"),
      "impl-b": implementation("impl-b", "b", "fail", "fail", "2026-01-01T00:06:00.000Z"),
      "impl-d": implementation("impl-d", "d", "pass", "skip", "2026-01-01T00:08:00.000Z"),
    };
    snapshot.versions = {
      a: version("a", 1, "implemented", "intent-a", ["decision-a"], ["impl-a-old", "impl-a"], "2026-01-01T00:00:00.000Z"),
      b: version("b", 2, "implemented", "intent-b", ["decision-b"], ["impl-b"], "2026-01-01T00:00:00.000Z"),
      c: version("c", 3, "rejected", "intent-c", ["decision-c"], [], "2026-01-01T00:00:00.000Z"),
      d: version("d", 4, "implemented", "intent-d", ["decision-d"], ["impl-d"], "2026-01-01T00:00:00.000Z"),
    };

    const metrics = computeProjectMetrics(snapshot, {
      calls: 2,
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      costUsd: 0.0006,
      pricedCalls: 1,
    });

    expect(metrics.approval).toEqual({
      count: 3,
      averageMs: 240_000,
      medianMs: 240_000,
    });
    expect(metrics.drift).toEqual({ implemented: 3, drifted: 1, rate: 1 / 3 });
    expect(metrics.reuse).toEqual({
      applicable: 2,
      passed: 1,
      skipped: 1,
      failed: 1,
      rate: 0.5,
    });
    expect(metrics.usage.totalTokens).toBe(1500);
  });

  it("ignores non-monotonic approval clocks and returns null rates with no data", () => {
    const snapshot = emptySnapshot();
    snapshot.intents = { "intent-a": intent("a", "2026-01-02T00:00:00.000Z") };
    snapshot.decisions = {
      "decision-a": decision("decision-a", "a", "approved", "2026-01-01T00:00:00.000Z"),
    };
    snapshot.versions = {
      a: version("a", 1, "approved", "intent-a", ["decision-a"], [], "2026-01-02T00:00:00.000Z"),
    };

    const metrics = computeProjectMetrics(snapshot, {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      pricedCalls: 0,
    });

    expect(metrics.approval).toEqual({ count: 0, averageMs: null, medianMs: null });
    expect(metrics.drift.rate).toBeNull();
    expect(metrics.reuse.rate).toBeNull();
  });
});
