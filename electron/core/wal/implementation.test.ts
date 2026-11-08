import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import type { ImplementationRecord } from "../../../shared/arch/types";
import {
  hasFailedDrift,
  latestImplementation,
} from "../../../shared/arch/conformance";
import { formatHlc, HlcClock, parseHlc } from "../time/hlc";
import { ulid } from "../ids/ulid";
import { foldWal } from "./fold";
import { parseWalText } from "./io";
import { makeImplementationRecord } from "./record";

const V2 = "01HF7YAT02BPT76MP9H15XNEFG";

function fixtureRecords() {
  const path = fileURLToPath(new URL("./fixtures/golden-wal.jsonl", import.meta.url));
  const parsed = parseWalText(readFileSync(path, "utf8"));
  expect(parsed.errors).toEqual([]);
  return parsed.records;
}

describe("implementation records", () => {
  it("keys snapshot implementations by WAL record id so version lookups work", () => {
    const records = fixtureRecords();
    const last = records[records.length - 1];
    expect(last).toBeDefined();
    const payload: ImplementationRecord = {
      id: ulid(),
      versionId: V2,
      gitCommit: "test-commit",
      files: ["src/Counter.tsx"],
      checks: [
        {
          name: "architecture conformance",
          status: "fail",
          detail: "1 of 2 conformance checks failed",
        },
      ],
      conformance: [
        {
          opId: "drift",
          kind: "drift",
          status: "fail",
          evidence: ["Undeclared source node src/Other.tsx"],
        },
      ],
      actor: { id: "user:test", kind: "user", name: "Test" },
      createdAt: new Date().toISOString(),
    };
    const clock = new HlcClock("user:test", parseHlc(last!.hlc));
    const record = makeImplementationRecord(
      {
        id: ulid(),
        versionId: V2,
        actor: payload.actor,
        hlc: formatHlc(clock.now()),
        parents: [last!.id],
      },
      payload,
    );

    const folded = foldWal([...records, record]);
    expect(folded.conflicts).toEqual([]);
    const version = folded.snapshot.versions[V2];
    expect(version?.status).toBe("implemented");
    expect(folded.snapshot.implementations[record.id]).toEqual(payload);

    const implementation = latestImplementation(folded.snapshot, version!);
    expect(implementation?.id).toBe(payload.id);
    expect(hasFailedDrift(implementation)).toBe(true);
  });
});
