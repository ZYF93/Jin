import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { cachePath } from "../project/config";
import { costOf, UsageLedger } from "./usage";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jin-usage-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("UsageLedger", () => {
  it("prices calls and persists them across a reload", () => {
    const root = tempRoot();
    const ledger = new UsageLedger(root);
    ledger.record(
      "implement",
      "model-a",
      { promptTokens: 1_000_000, completionTokens: 500_000 },
      { inputPerMillion: 3, outputPerMillion: 12 },
    );
    ledger.record(
      "plan",
      "model-a",
      { promptTokens: 1000, completionTokens: 0 },
      { inputPerMillion: 0, outputPerMillion: 0 },
    );

    expect(ledger.totals()).toEqual({
      calls: 2,
      promptTokens: 1_001_000,
      completionTokens: 500_000,
      totalTokens: 1_501_000,
      costUsd: 9,
      pricedCalls: 1,
    });

    const reloaded = new UsageLedger(root);
    expect(reloaded.totals()).toEqual(ledger.totals());
    expect(reloaded.list().map((entry) => entry.source)).toEqual(["implement", "plan"]);
  });

  it("ignores empty responses and corrupt caches", () => {
    const root = tempRoot();
    const ledger = new UsageLedger(root);
    ledger.record(
      "eko",
      "model",
      { promptTokens: 0, completionTokens: 0 },
      { inputPerMillion: 3, outputPerMillion: 12 },
    );
    expect(ledger.totals().calls).toBe(0);

    mkdirSync(cachePath(root), { recursive: true });
    writeFileSync(join(cachePath(root), "usage.json"), "{not json", "utf8");
    expect(new UsageLedger(root).totals().calls).toBe(0);
  });
});

describe("costOf", () => {
  it("prices prompt and completion tokens per million independently", () => {
    expect(
      costOf(
        { promptTokens: 2_000_000, completionTokens: 250_000 },
        { inputPerMillion: 1.5, outputPerMillion: 6 },
      ),
    ).toBe(4.5);
  });
});
