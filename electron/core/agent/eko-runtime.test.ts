import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ArchNode, ArchSnapshot, Intent } from "../../../shared/arch/types";
import { emptySnapshot } from "../arch/snapshot";
import { resilientProviderFetch } from "./provider";
import {
  architectureSummary,
  ekoLlmConfig,
  MAX_STAGED_BYTES,
  normalizeProjectPath,
  StagedWorkspace,
} from "./eko-runtime";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "jin-eko-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "counter.ts"), "export const count = 0;\n", "utf8");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function archNode(id: string, name: string, file: string): ArchNode {
  return {
    id,
    level: "L1",
    kind: "component",
    parentId: null,
    name,
    path: file,
    file,
    symbol: "",
    responsibility: `${name} responsibility.`,
    intentId: null,
    status: "active",
    metadata: {},
    introducedIn: "v1",
    updatedIn: "v1",
    lastTouchedIn: null,
  };
}

describe("StagedWorkspace", () => {
  it("stages complete writes and deletes without touching disk", () => {
    const root = fixture();
    const workspace = new StagedWorkspace(root);

    expect(workspace.read("src/counter.ts")).toContain("count = 0");
    workspace.stageWrite("src/counter.ts", "export const count = 1;\n");
    workspace.stageWrite("src/new.ts", "export const added = true;\n");
    workspace.stageDelete("src/old.ts");
    workspace.stageDelete("src/old.ts");

    expect(readFileSync(join(root, "src", "counter.ts"), "utf8")).toContain("count = 0");
    expect(workspace.read("src/counter.ts")).toContain("count = 1");
    expect(workspace.toEdits()).toEqual([
      { path: "src/counter.ts", content: "export const count = 1;\n" },
      { path: "src/new.ts", content: "export const added = true;\n" },
      { path: "src/old.ts", delete: true },
    ]);
  });

  it("rejects ledger, toolchain, escape and absolute paths", () => {
    const root = fixture();
    const workspace = new StagedWorkspace(root);
    for (const path of [
      ".jin/wal.jsonl",
      ".git/config",
      "node_modules/pkg/index.js",
      "dist/app.js",
      "../outside.ts",
      "/etc/passwd",
      "C:/Windows/system32/drivers/etc/hosts",
      "",
    ]) {
      expect(() => workspace.stageWrite(path, "x")).toThrow();
    }
    expect(() => normalizeProjectPath("src/../src/ok.ts")).toThrow();
    expect(normalizeProjectPath("./src/ok.ts")).toBe("src/ok.ts");
  });

  it("enforces the staged edit size limit", () => {
    const root = fixture();
    const workspace = new StagedWorkspace(root, 8);
    expect(() => workspace.stageWrite("src/big.ts", "123456789")).toThrow(/edit limit/);
    expect(workspace.stageWrite("src/small.ts", "12345678").bytes).toBe(8);
    expect(MAX_STAGED_BYTES).toBe(2 * 1024 * 1024);
  });

  it("refuses to read a file deleted in the same run", () => {
    const root = fixture();
    const workspace = new StagedWorkspace(root);
    workspace.stageDelete("src/counter.ts");
    expect(() => workspace.read("src/counter.ts")).toThrow(/deleted/);
  });
});

describe("architectureSummary", () => {
  it("includes layers, relationships and the approved intent", () => {
    const snapshot: ArchSnapshot = {
      ...emptySnapshot(),
      nodes: {
        module: archNode("module", "Counter", "src/counter.ts"),
        hook: archNode("hook", "useCounter", "src/use-counter.ts"),
      },
      edges: {
        "edge-1": {
          id: "edge-1",
          from: "hook",
          to: "module",
          kind: "uses",
          metadata: {},
          introducedIn: "v1",
        },
      },
    };
    const intent: Intent = {
      id: "intent",
      versionId: "version",
      title: "Add reset",
      goal: "Let the counter reset to zero.",
      tasks: [],
      nodeIntents: [
        {
          nodeId: "module",
          facetId: "facet",
          statement: "Expose reset().",
          invariants: [],
          acceptance: [],
        },
      ],
      author: { id: "actor", kind: "user", name: "Tester", email: "" },
      createdAt: new Date().toISOString(),
    };
    const text = architectureSummary(snapshot, intent);
    expect(text).toContain("Counter");
    expect(text).toContain("useCounter");
    expect(text).toContain("hook -[uses]-> module");
    expect(text).toContain("Add reset: Let the counter reset to zero.");
    expect(text).toContain("module#facet: Expose reset().");
  });
});

describe("ekoLlmConfig", () => {
  it("maps Jin's provider settings to an OpenAI-compatible Eko LLM", () => {
    const config = ekoLlmConfig({
      root: "/tmp",
      provider: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:8787/v1",
        model: "mock-model",
        apiKey: "secret",
      },
      system: "",
      task: "",
      temperature: 0.1,
      maxTokens: 4000,
      signal: new AbortController().signal,
      snapshot: emptySnapshot(),
      intent: {} as Intent,
      ops: [],
      reusePlan: null,
      searchCode: () => [],
    });
    expect(config).toEqual({
      provider: "openai-compatible",
      model: "mock-model",
      apiKey: "secret",
      fetch: resilientProviderFetch,
      config: {
        baseURL: "http://127.0.0.1:8787/v1",
        temperature: 0.1,
        maxOutputTokens: 4000,
      },
    });
  });

  it("uses a local placeholder key for keyless Ollama-style endpoints", () => {
    const config = ekoLlmConfig({
      root: "/tmp",
      provider: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen",
        apiKey: null,
      },
      system: "",
      task: "",
      temperature: 0,
      maxTokens: 1024,
      signal: new AbortController().signal,
      snapshot: emptySnapshot(),
      intent: {} as Intent,
      ops: [],
      reusePlan: null,
      searchCode: () => [],
    });
    expect(config.apiKey).toBe("jin-local");
  });
});
