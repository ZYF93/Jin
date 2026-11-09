import { describe, expect, it } from "vite-plus/test";
import type { ArchNodeDraft } from "../../../shared/ledger/types";
import type { ScanResult } from "./scanner";
import { applySemanticRefinement, parseSemanticRefinement, semanticPath } from "./semantic";

function moduleNode(path: string, name: string): ArchNodeDraft {
  return {
    id: `module-${name}`,
    level: "L0",
    kind: "module",
    parentId: null,
    name,
    path,
    file: "",
    symbol: "",
    responsibility: `Contains ${name} source units.`,
    intentId: null,
    status: "active",
    metadata: { origin: "scan", scanned: true },
  };
}

function fileNode(path: string): ArchNodeDraft {
  return {
    id: "file-billing",
    level: "L1",
    kind: "function",
    parentId: "module-src",
    name: "billing",
    path,
    file: path,
    symbol: "",
    responsibility: "Provides charge.",
    intentId: null,
    status: "active",
    metadata: { origin: "scan", scanned: true, scanKind: "function" },
  };
}

function scanFixture(): ScanResult {
  const path = "src/billing.ts";
  return {
    files: [
      {
        path,
        absolute: `/tmp/project/${path}`,
        language: "typescript",
        lines: 40,
        symbolLocations: {},
        bytes: 800,
        imports: ["./money"],
        exports: ["charge"],
        members: [{ name: "refund", kind: "method" }],
        kind: "function",
        title: "billing",
        responsibility: "Provides charge.",
      },
    ],
    nodes: [moduleNode("src", "src"), fileNode(path)],
    edges: [],
    warnings: [],
    stats: {
      files: 1,
      symbols: 2,
      imports: 1,
      nodes: 2,
      edges: 0,
      languages: { typescript: 1 },
    },
    scannedAt: "2026-10-28T00:00:00.000Z",
    manifest: {},
  };
}

describe("parseSemanticRefinement", () => {
  it("validates paths, kinds and symbols against structural/LSP facts", () => {
    const scan = scanFixture();
    const refinement = parseSemanticRefinement(
      {
        files: [
          {
            path: "./src/billing.ts",
            kind: "service",
            responsibility: "  Charges cards and records the result.  ",
            domain: "Billing",
            symbols: ["charge", "refund", "ghost"],
          },
          {
            path: "src/invented.ts",
            kind: "service",
            responsibility: "Does not exist.",
          },
          {
            path: "src/billing.ts",
            kind: "banana",
            responsibility: "",
          },
        ],
        modules: [
          {
            path: "src",
            responsibility: "Coordinates billing behavior across application entry points.",
            domain: "billing",
          },
        ],
      },
      scan,
    );

    expect(refinement.files).toEqual([
      {
        path: "src/billing.ts",
        kind: "service",
        responsibility: "Charges cards and records the result.",
        domain: "billing",
        symbols: ["charge", "refund"],
      },
    ]);
    expect(refinement.modules).toEqual([
      {
        path: "src",
        responsibility: "Coordinates billing behavior across application entry points.",
        domain: "billing",
      },
    ]);
    expect(refinement.warnings).toEqual([
      "Semantic pass ignored 1 path that is not in the structural scan.",
      "Semantic pass rejected 1 symbol not confirmed by LSP or structural facts.",
    ]);
  });

  it("rejects paths that escape the project", () => {
    expect(semanticPath("../outside.ts")).toBeNull();
    expect(semanticPath("/etc/passwd")).toBeNull();
    expect(semanticPath("C:/Windows/hosts")).toBeNull();
    expect(semanticPath("src/ok.ts")).toBe("src/ok.ts");
  });

  it("returns no refinement for malformed output", () => {
    const refinement = parseSemanticRefinement({ files: "nope" }, scanFixture());
    expect(refinement.files).toEqual([]);
    expect(refinement.modules).toEqual([]);
    expect(refinement.warnings[0]).toContain("no file refinements");
  });
});

describe("applySemanticRefinement", () => {
  it("updates L1 metadata and summarizes domains on the containing L0 module", () => {
    const scan = scanFixture();
    const refinement = parseSemanticRefinement(
      {
        files: [
          {
            path: "src/billing.ts",
            kind: "service",
            responsibility: "Charges cards and records the result.",
            domain: "billing",
            symbols: ["charge"],
          },
        ],
        modules: [
          {
            path: "src",
            responsibility: "Coordinates billing behavior across application entry points.",
            domain: "billing",
          },
        ],
      },
      scan,
    );
    const applied = applySemanticRefinement(scan, refinement);

    expect(applied.refined).toBe(2);
    const file = applied.scan.files[0];
    expect(file?.kind).toBe("service");
    expect(file?.responsibility).toBe("Charges cards and records the result.");
    const fileNode = applied.scan.nodes.find((node) => node.level === "L1");
    expect(fileNode?.kind).toBe("service");
    expect(fileNode?.responsibility).toBe("Charges cards and records the result.");
    expect(fileNode?.metadata.scanKind).toBe("function");
    expect(fileNode?.metadata.semantic).toBe(true);
    expect(fileNode?.metadata.domain).toBe("billing");
    expect(fileNode?.metadata.semanticSymbols).toEqual(["charge"]);
    const module = applied.scan.nodes.find((node) => node.level === "L0");
    expect(module?.responsibility).toBe(
      "Coordinates billing behavior across application entry points.",
    );
    expect(module?.metadata.domains).toEqual(["billing"]);
    expect(module?.metadata.domain).toBe("billing");
  });

  it("keeps the scan unchanged when the model produced nothing valid", () => {
    const scan = scanFixture();
    const applied = applySemanticRefinement(scan, {
      files: [],
      modules: [],
      warnings: [],
    });
    expect(applied.refined).toBe(0);
    expect(applied.scan).toBe(scan);
  });
});
