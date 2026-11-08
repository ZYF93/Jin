import { describe, expect, it } from "vite-plus/test";
import type { ReusePlan } from "../../../shared/ipc";
import type { ScanResult } from "../scan/scanner";
import { evaluateReuse } from "./reuse-guard";

function scan(files: Array<{ path: string; exports: string[] }>): ScanResult {
  return {
    files: files.map((file) => ({
      path: file.path,
      absolute: `/tmp/${file.path}`,
      language: "typescript",
      lines: 1,
      symbolLocations: {},
      bytes: 1,
      imports: [],
      exports: file.exports,
      members: [],
      kind: "function",
      title: file.path,
      responsibility: "",
    })),
    nodes: [],
    edges: [],
    warnings: [],
    stats: { files: files.length, symbols: 0, imports: 0, nodes: 0, edges: 0, languages: {} },
    scannedAt: new Date().toISOString(),
    manifest: {},
  };
}

function plan(path = "src/math.ts"): ReusePlan {
  return {
    query: "sum numbers",
    summary: "One candidate.",
    createdAt: new Date().toISOString(),
    candidates: [
      {
        path,
        symbol: "sumAll",
        score: 8,
        reason: "Sum values.",
        snippet: "export function sumAll() {}",
      },
    ],
  };
}

describe("evaluateReuse", () => {
  it("passes when no candidate was required", () => {
    const check = evaluateReuse({
      plan: null,
      scan: scan([]),
      changedPaths: ["src/new.ts"],
    });
    expect(check.status).toBe("pass");
  });

  it("passes when the candidate file itself was updated", () => {
    const check = evaluateReuse({
      plan: plan(),
      scan: scan([{ path: "src/math.ts", exports: ["sumAll"] }]),
      changedPaths: ["src/math.ts"],
      edits: [{ path: "src/math.ts", content: "export function sumAll() { return 0; }" }],
    });
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("src/math.ts");
  });

  it("fails when a new file duplicates an untouched candidate export", () => {
    const check = evaluateReuse({
      plan: plan(),
      scan: scan([{ path: "src/math.ts", exports: ["sumAll"] }]),
      changedPaths: ["src/extra.ts"],
      edits: [{ path: "src/extra.ts", content: "export function sumAll() { return 1; }" }],
    });
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("duplicates src/math.ts");
  });

  it("skips with a review hint when a candidate was not touched", () => {
    const check = evaluateReuse({
      plan: plan(),
      scan: scan([{ path: "src/math.ts", exports: ["sumAll"] }]),
      changedPaths: ["src/extra.ts"],
      edits: [{ path: "src/extra.ts", content: "export function sumDifferent() { return 1; }" }],
    });
    expect(check.status).toBe("skip");
    expect(check.detail).toContain("changed none");
  });
});
