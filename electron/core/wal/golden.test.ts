import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import type { ArchSnapshot } from "../../../shared/arch/types";
import { hashSnapshot } from "../arch/snapshot";
import { foldWal } from "./fold";
import { parseWalText, serializeWal } from "./io";

interface GoldenSnapshot {
  snapshotHash: string;
  versions: Array<{
    id: string;
    intentId: string;
    status: string;
    ordinal: number | null;
    baseHash: string | null;
    targetHash: string | null;
    diffHash: string | null;
  }>;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function projection(snapshot: ArchSnapshot): GoldenSnapshot {
  return {
    snapshotHash: hashSnapshot(snapshot),
    versions: Object.values(snapshot.versions)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((version) => ({
        id: version.id,
        intentId: version.intentId,
        status: version.status,
        ordinal: version.ordinal,
        baseHash: version.baseHash,
        targetHash: version.targetHash,
        diffHash: version.diffHash,
      })),
    nodes: Object.values(snapshot.nodes)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((node) => ({
        id: node.id,
        level: node.level,
        kind: node.kind,
        parentId: node.parentId,
        name: node.name,
        path: node.path,
        file: node.file,
        responsibility: node.responsibility,
        metadata: node.metadata,
        introducedIn: node.introducedIn,
        updatedIn: node.updatedIn,
        lastTouchedIn: node.lastTouchedIn,
      })),
    edges: Object.values(snapshot.edges)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        metadata: edge.metadata,
        introducedIn: edge.introducedIn,
      })),
  };
}

describe("golden WAL fixture", () => {
  it("folds a frozen structural + touch + rejected history deterministically", () => {
    const text = readFileSync(fixture("golden-wal.jsonl"), "utf8");
    const parsed = parseWalText(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.records).toHaveLength(13);

    const folded = foldWal(parsed.records);
    expect(folded.conflicts).toEqual([]);
    expect(folded.warnings).toEqual([]);

    const golden = JSON.parse(
      readFileSync(fixture("golden-snapshot.json"), "utf8"),
    ) as GoldenSnapshot;
    expect(projection(folded.snapshot)).toEqual(golden);
    expect(hashSnapshot(folded.snapshot)).toBe(golden.snapshotHash);
    // Version history stores WAL record ids; the decision map must use the same
    // keys or metrics/replay lookups silently miss decisions.
    for (const version of Object.values(folded.snapshot.versions)) {
      for (const id of version.decisions) {
        expect(folded.snapshot.decisions[id]?.versionId).toBe(version.id);
      }
    }
  });

  it("round-trips the frozen records without changing bytes or hashes", () => {
    const text = readFileSync(fixture("golden-wal.jsonl"), "utf8");
    const parsed = parseWalText(text);
    expect(parsed.errors).toEqual([]);
    expect(serializeWal(parsed.records)).toBe(text);
  });
});
