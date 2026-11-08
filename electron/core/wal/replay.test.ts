import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { foldWal } from "./fold";
import { parseWalText } from "./io";
import { replayVersion } from "./replay";

const V1 = "01HF7YAT01W8VZEYM5S17CPH7V";
const V2 = "01HF7YAT02BPT76MP9H15XNEFG";
const V3 = "01HF7YAT0314R1HQHTRF5WZWAB";
const COUNTER = "01HF7YAT06CY5XXMJ3NQ3NPBSN";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function records() {
  const parsed = parseWalText(readFileSync(fixture("golden-wal.jsonl"), "utf8"));
  expect(parsed.errors).toEqual([]);
  return parsed.records;
}

describe("replayVersion", () => {
  it("reconstructs the first approved version from an empty base", () => {
    const replay = replayVersion(records(), V1);
    expect(replay.status).toBe("approved");
    expect(replay.applied).toBe(true);
    expect(replay.baseSnapshot.nodes).toEqual({});
    expect(replay.baseSnapshot.edges).toEqual({});
    expect(replay.baseHash).toBe(
      "sha256:57501e5c6808b3e14852a4ea21dc7873abf9409032a06f9b740c973e83f62cf7",
    );
    expect(replay.targetHash).toBe(
      "sha256:07d14f7a14f8002eaf48e811c9cbc00568f6013ba669a425755d7601bd4556b8",
    );
    expect(replay.warnings).toEqual([]);
    expect(replay.diff.summary.added).toBe(4);
    expect(replay.targetSnapshot.nodes[COUNTER]?.name).toBe("Counter");
  });

  it("rebases a touch-only version on the previous approval, not a time cutoff", () => {
    const replay = replayVersion(records(), V2);
    expect(replay.status).toBe("approved");
    expect(replay.applied).toBe(true);
    expect(replay.baseHash).toBe(
      "sha256:07d14f7a14f8002eaf48e811c9cbc00568f6013ba669a425755d7601bd4556b8",
    );
    expect(replay.targetHash).toBe(replay.baseHash);
    expect(replay.diff.summary.added).toBe(0);
    expect(replay.diff.summary.removed).toBe(0);
    expect(replay.diff.summary.modified).toBe(0);
    // The later rejected rename is not an ancestor of this version and must not leak in.
    expect(replay.targetSnapshot.nodes[COUNTER]?.name).toBe("Counter");
    expect(replay.warnings).toEqual([]);
  });

  it("shows a rejected version as a proposal and never applies it", () => {
    const replay = replayVersion(records(), V3);
    expect(replay.status).toBe("rejected");
    expect(replay.applied).toBe(false);
    expect(replay.decision?.decision).toBe("rejected");
    expect(replay.targetSnapshot.nodes[COUNTER]?.name).toBe("RenamedCounter");
    expect(replay.diff.nodes[COUNTER]?.change).toBe("modified");
    // A rejection may bind the unchanged base as its target; the proposal is
    // still reconstructed from the version's own ops and is never a hash error.
    expect(replay.decision?.targetHash).toBe(replay.baseHash);
    expect(replay.targetHash).not.toBe(replay.decision?.targetHash);
    expect(replay.warnings).toEqual([]);

    const live = foldWal(records()).snapshot;
    expect(live.nodes[COUNTER]?.name).toBe("Counter");
  });

  it("warns when an approved target hash does not match the reconstruction", () => {
    const tampered = records().map((record) =>
      record.t === "decision" && record.versionId === V1
        ? {
            ...record,
            payload: { ...record.payload, targetHash: "sha256:tampered" },
          }
        : record,
    );
    const replay = replayVersion(tampered, V1);
    expect(replay.warnings).toContain(
      "The approval target hash does not match the reconstructed target snapshot.",
    );
  });

  it("warns when the reviewed diff hash does not match the change set", () => {
    const tampered = records().map((record) =>
      record.t === "decision" && record.versionId === V1
        ? {
            ...record,
            payload: { ...record.payload, diffHash: "sha256:tampered" },
          }
        : record,
    );
    const replay = replayVersion(tampered, V1);
    expect(replay.warnings).toContain(
      "The approval diff hash does not match the reconstructed change set.",
    );
  });

  it("rejects an unknown version", () => {
    expect(() => replayVersion(records(), "01HF7YAT99ZZZZZZZZZZZZZZZZ")).toThrow(
      /no intent record exists/,
    );
  });
});
