import { describe, expect, it } from "vite-plus/test";
import { runArchitectureDesignAgent } from "./arch-agent";
import type { ScanResult } from "./scanner";

/** A minimal structural scan: one directory, two files. */
function scanFixture(): ScanResult {
  const files = [
    {
      path: "src/billing.ts",
      absolute: "/tmp/p/src/billing.ts",
      language: "typescript",
      lines: 20,
      symbolLocations: {},
      bytes: 100,
      imports: [] as string[],
      exports: ["charge"],
      members: [{ name: "charge", kind: "method" as const }],
      kind: "function" as const,
      title: "billing",
      responsibility: "",
    },
    {
      path: "src/router.ts",
      absolute: "/tmp/p/src/router.ts",
      language: "typescript",
      lines: 15,
      symbolLocations: {},
      bytes: 80,
      imports: ["./billing"],
      exports: ["route"],
      members: [{ name: "route", kind: "method" as const }],
      kind: "function" as const,
      title: "router",
      responsibility: "",
    },
  ];
  return {
    files,
    nodes: [
      {
        id: "mod-src",
        level: "L0",
        kind: "module",
        parentId: null,
        name: "src",
        path: "src",
        file: "",
        symbol: "",
        responsibility: "",
        intentId: null,
        status: "active",
        metadata: { origin: "scan" },
      },
    ],
    edges: [],
    warnings: [],
    stats: { files: 2, symbols: 0, imports: 1, nodes: 3, edges: 0, languages: { typescript: 2 } },
    scannedAt: "2026-01-01T00:00:00Z",
    manifest: {},
  };
}

type ToolLike = { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> };

/**
 * A fake Eko module. Its Agent stores the tools; its Eko.execute finds the
 * submit_architecture tool and calls it with a hand-built design. No real LLM.
 */
function fakeEkoModule(nodes: Array<Record<string, unknown>>): unknown {
  class Agent {
    tools: ToolLike[];
    constructor(opts: { tools: ToolLike[] }) {
      this.tools = opts.tools;
    }
    async extSysPrompt(): Promise<string> {
      return "";
    }
  }
  class Eko {
    readonly agent: Agent;
    constructor(opts: { agents: Agent[] }) {
      this.agent = opts.agents[0];
    }
    async initContext(): Promise<void> {}
    async execute() {
      const submit = this.agent.tools.find((tool) => tool.name === "submit_architecture");
      if (submit) await submit.execute({ nodes } as never);
      return { success: true, result: "ok", stopReason: "complete" };
    }
    abortTask(): void {}
    deleteTask(): void {}
  }
  return {
    Agent,
    Eko,
    buildSimpleAgentWorkflow: () => ({}),
    config: { maxReactNum: 0 },
  };
}

describe("runArchitectureDesignAgent", () => {
  it("grafts a submitted design onto the scan and drops invented paths", async () => {
    const module = fakeEkoModule([
      { level: "L1", path: "src/billing.ts", kind: "service", responsibility: "Charges cards." },
      { level: "L1", path: "src/invented.ts", kind: "service", responsibility: "Invented." },
    ]);
    const result = await runArchitectureDesignAgent({
      root: "/tmp/p",
      provider: {
        kind: "openai-compatible",
        baseUrl: "https://x/v1",
        model: "m",
        apiKey: "k",
      } as never,
      scan: scanFixture(),
      signal: new AbortController().signal,
      load: () => Promise.resolve(module as never),
    });
    expect(result.applied).toBe(true);
    const billing = result.scan.files.find((file) => file.path === "src/billing.ts");
    expect(billing?.responsibility).toBe("Charges cards.");
    expect(result.scan.files.some((file) => file.path === "src/invented.ts")).toBe(false);
  });

  it("leaves the scan untouched when the agent submits no usable design", async () => {
    const module = fakeEkoModule([]);
    const input = scanFixture();
    const result = await runArchitectureDesignAgent({
      root: "/tmp/p",
      provider: {
        kind: "openai-compatible",
        baseUrl: "https://x/v1",
        model: "m",
        apiKey: "k",
      } as never,
      scan: input,
      signal: new AbortController().signal,
      load: () => Promise.resolve(module as never),
    });
    expect(result.applied).toBe(false);
    expect(result.scan).toBe(input);
  });
});
