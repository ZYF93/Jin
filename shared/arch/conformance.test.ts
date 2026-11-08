import { describe, expect, it } from "vite-plus/test";
import type {
  ArchSnapshot,
  ConformanceResult,
  ImplementationRecord,
  VersionState,
} from "./types";
import {
  failedConformance,
  hasFailedDrift,
  isDriftResult,
  latestImplementation,
} from "./conformance";

function result(patch: Partial<ConformanceResult>): ConformanceResult {
  return {
    opId: "op:1",
    status: "fail",
    evidence: [],
    ...patch,
  };
}

function implementation(patch: Partial<ImplementationRecord>): ImplementationRecord {
  return {
    id: "01HF7YAT00AAAAAAAAAAAAAAAA",
    versionId: "01HF7YAT01W8VZEYM5S17CPH7V",
    gitCommit: "",
    files: [],
    checks: [],
    conformance: [],
    actor: { id: "user:test", kind: "user", name: "Test" },
    createdAt: "2023-11-14T22:13:20.000Z",
    ...patch,
  };
}

describe("conformance helpers", () => {
  it("recognizes explicit and legacy drift results", () => {
    expect(isDriftResult(result({ kind: "drift", evidence: [] }))).toBe(true);
    expect(
      isDriftResult(result({ evidence: ["Undeclared source node 01HF7YAT06CY5XXMJ3NQ3NPBSN"] })),
    ).toBe(true);
    expect(
      isDriftResult(result({ evidence: ["Declared node 01HF7YAT06CY5XXMJ3NQ3NPBSN has no source fact"] })),
    ).toBe(true);
    expect(
      isDriftResult(result({ evidence: ["No architecture drift detected between approved L0/L1 nodes and source scan"] })),
    ).toBe(true);
    expect(
      isDriftResult(result({ kind: "op", evidence: ["Undeclared source node fake"] })),
    ).toBe(false);
    expect(isDriftResult(result({ evidence: ["Not observed in a fresh scan: L1 X (src/X.tsx)"] }))).toBe(
      false,
    );
  });

  it("only reports drift when the drift check itself failed", () => {
    expect(
      hasFailedDrift(
        implementation({
          conformance: [
            result({
              kind: "drift",
              evidence: ["Declared node 01HF7YAT06CY5XXMJ3NQ3NPBSN has no source fact"],
            }),
          ],
        }),
      ),
    ).toBe(true);
    expect(
      hasFailedDrift(
        implementation({
          conformance: [
            result({ kind: "drift", status: "pass", evidence: ["No drift"] }),
            result({ kind: "op", evidence: ["Not observed in a fresh scan"] }),
          ],
        }),
      ),
    ).toBe(false);
    expect(hasFailedDrift(null)).toBe(false);
  });

  it("finds the latest implementation record and its failures", () => {
    const first = implementation({ id: "01HF7YAT00AAAAAAAAAAAAAAAB" });
    const second = implementation({
      id: "01HF7YAT00AAAAAAAAAAAAAAAC",
      conformance: [result({ kind: "drift", evidence: ["Declared node X has no source fact"] })],
    });
    const snapshot = {
      implementations: { [first.id]: first, [second.id]: second },
    } as unknown as ArchSnapshot;
    const version = {
      implementations: [first.id, second.id],
    } as unknown as VersionState;
    expect(latestImplementation(snapshot, version)?.id).toBe(second.id);
    expect(failedConformance(second)).toHaveLength(1);
  });
});
