import { describe, expect, it } from "vite-plus/test";
import type { ArchNodeDraft } from "../../../shared/ledger/types";
import type { ScanResult } from "./scanner";
import { afterEach } from "vite-plus/test";
import {
  applySemanticRefinement,
  parseSemanticRefinement,
  runSemanticPass,
  semanticPath,
} from "./semantic";

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
        members: [],
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

describe("runSemanticPass AGENTS.md rules", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("injects AGENTS.md rules into the semantic refine system prompt", async () => {
    let captured: { system?: string; user?: string } = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        messages?: Array<{ role: string; content: string }>;
      };
      const messages = body.messages ?? [];
      captured = {
        system: messages.find((message) => message.role === "system")?.content,
        user: messages.find((message) => message.role === "user")?.content,
      };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ files: [], modules: [] }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await runSemanticPass(
      scanFixture(),
      { kind: "openai-compatible", baseUrl: "https://x/v1", model: "m", apiKey: "k" },
      { rules: "PROJECT RULES (AGENTS.md in the project root):\nUse src/features." },
    );

    expect(captured.system).toContain("PROJECT RULES");
    expect(captured.system).toContain("Use src/features.");
  });

  it("sends the plain system prompt when no rules are given", async () => {
    let system = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        messages?: Array<{ role: string; content: string }>;
      };
      system = body.messages?.find((message) => message.role === "system")?.content ?? "";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ files: [], modules: [] }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await runSemanticPass(scanFixture(), {
      kind: "openai-compatible",
      baseUrl: "https://x/v1",
      model: "m",
      apiKey: "k",
    });

    expect(system).not.toContain("PROJECT RULES (AGENTS.md");
  });

  it("grounds L0 module prompts in the actual child files, not a count", async () => {
    let user = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        messages?: Array<{ role: string; content: string }>;
      };
      user = body.messages?.find((message) => message.role === "user")?.content ?? "";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ files: [], modules: [] }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    // Two files in nested dirs under module path "src/wal".
    const nested = scanFixture();
    nested.files = [
      { ...nested.files[0]!, path: "src/wal/record.ts", absolute: "/p/src/wal/record.ts" },
      { ...nested.files[0]!, path: "src/wal/merge.ts", absolute: "/p/src/wal/merge.ts" },
    ];
    nested.nodes = [
      { ...nested.nodes.find((n) => n.level === "L0")!, path: "src/wal", name: "wal" },
    ] as Array<import("../../../shared/ledger/types").ArchNodeDraft>;
    await runSemanticPass(nested, {
      kind: "openai-compatible",
      baseUrl: "https://x/v1",
      model: "m",
      apiKey: "k",
    });

    const prompt = JSON.parse(user) as { modules: Array<Record<string, unknown>> };
    const moduleEntry = prompt.modules.find((m) => m.path === "src/wal");
    expect(moduleEntry).toBeDefined();
    const childFiles = moduleEntry?.["childFiles"] as string[];
    // The module's prompt must reference its real child files, so the model
    // can describe the subsystem instead of falling back to "contains N".
    expect(childFiles).toEqual(expect.arrayContaining(["record.ts", "merge.ts"]));
  });

  it("reports unrefined modules instead of substituting a local summary", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      return new Response(
        JSON.stringify({
          // Model refines the file but returns no module responsibilities.
          choices: [
            {
              message: {
                content: JSON.stringify({
                  files: [
                    {
                      path: "src/billing.ts",
                      kind: "service",
                      responsibility: "Charges cards.",
                      domain: "billing",
                    },
                  ],
                  modules: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await runSemanticPass(scanFixture(), {
      kind: "openai-compatible",
      baseUrl: "https://x/v1",
      model: "m",
      apiKey: "k",
    });

    // The "src" L0 module got no model responsibility, so it must be reported as
    // unrefined (for a manual retry) rather than silently given a local summary.
    expect(result.hasUnrefined).toBe(true);
    expect(result.unrefined.modules.some((node) => node.path === "src")).toBe(true);
    const module = result.scan.nodes.find((node) => node.level === "L0");
    // No local "Domain …: N source units" template was substituted.
    expect(module?.responsibility).not.toMatch(/Domain .*source units/);
  });
});

describe("member (facet) refinements", () => {
  function facetNode(): ArchNodeDraft {
    return {
      id: "file-billing-facet-refund",
      level: "facet",
      kind: "method",
      parentId: "file-billing",
      name: "refund",
      path: "src/billing.ts",
      file: "src/billing.ts",
      symbol: "#refund",
      responsibility: "method refund on billing.",
      intentId: null,
      status: "active",
      metadata: { origin: "scan", scanned: true },
    };
  }

  it("accepts member responsibilities whose names exist in the scan", () => {
    const refinement = parseSemanticRefinement(
      {
        files: [
          {
            path: "src/billing.ts",
            members: [
              { name: "refund", responsibility: "Issues a refund against a completed charge." },
            ],
          },
        ],
      },
      scanFixture(),
    );
    expect(refinement.files[0]?.members).toEqual([
      { name: "refund", responsibility: "Issues a refund against a completed charge." },
    ]);
  });

  it("rejects member names not confirmed by the scan", () => {
    const refinement = parseSemanticRefinement(
      {
        files: [
          {
            path: "src/billing.ts",
            responsibility: "Charges cards and records the result.",
            members: [{ name: "deleteEverything", responsibility: "Not in the scan." }],
          },
        ],
      },
      scanFixture(),
    );
    expect(refinement.files[0]?.members).toEqual([]);
  });

  it("applies member responsibilities to facet nodes", () => {
    const scan = scanFixture();
    const withFacet: ScanResult = { ...scan, nodes: [...scan.nodes, facetNode()] };
    const applied = applySemanticRefinement(withFacet, {
      files: [
        {
          path: "src/billing.ts",
          symbols: [],
          members: [
            { name: "refund", responsibility: "Issues a refund against a completed charge." },
          ],
        },
      ],
      modules: [],
      warnings: [],
    });
    const facet = applied.scan.nodes.find((node) => node.id === "file-billing-facet-refund");
    expect(facet?.responsibility).toBe("Issues a refund against a completed charge.");
    expect(facet?.metadata.semantic).toBe(true);
  });
});
