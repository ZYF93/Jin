import { describe, expect, it } from "vite-plus/test";
import type { ArchNode, ArchSnapshot } from "../../../shared/ledger/types";
import { emptySnapshot } from "../arch/snapshot";
import { ProviderError } from "./provider";
import { architectureSummary, plannerContextBudget, planWithProvider } from "./llm-planner";

process.env.JIN_QUIET = "1";

function node(partial: Partial<ArchNode> & Pick<ArchNode, "id" | "level" | "name">): ArchNode {
  return {
    kind: partial.level === "L0" ? "module" : partial.level === "L1" ? "component" : "method",
    parentId: null,
    path: "",
    file: "",
    symbol: "",
    responsibility: "Responsibility",
    intentId: null,
    status: "active",
    metadata: {},
    introducedIn: "v1",
    updatedIn: "v1",
    lastTouchedIn: null,
    ...partial,
  };
}

function populatedSnapshot(): ArchSnapshot {
  const snapshot = emptySnapshot();
  snapshot.nodes["l0:system"] = node({
    id: "l0:system",
    level: "L0",
    kind: "system",
    name: "Jin",
    responsibility: "Root system",
  });
  snapshot.nodes["l0:module"] = node({
    id: "l0:module",
    level: "L0",
    name: "Architecture",
    parentId: "l0:system",
    path: "src/arch",
  });
  for (let index = 0; index < 30; index += 1) {
    const id = `l1:${index}`;
    snapshot.nodes[id] = node({
      id,
      level: "L1",
      name: `Unit${index}`,
      parentId: "l0:module",
      file: `src/arch/unit-${index}.ts`,
      responsibility: `A deliberately verbose responsibility line for unit ${index}.`,
    });
    snapshot.nodes[`facet:${index}`] = node({
      id: `facet:${index}`,
      level: "facet",
      name: `field${index}`,
      parentId: id,
      file: `src/arch/unit-${index}.ts`,
      symbol: `field${index}`,
    });
  }
  return snapshot;
}

describe("plannerContextBudget", () => {
  it("scales with the context window and compaction ratio", () => {
    expect(plannerContextBudget(128_000, 0.8)).toBe(204_800);
    expect(plannerContextBudget(32_000, 0.5)).toBe(32_000);
  });

  it("clamps tiny and invalid windows to a usable floor", () => {
    expect(plannerContextBudget(1_000, 0.1)).toBe(8_000);
    expect(plannerContextBudget(0, 0)).toBe(8_000);
    expect(plannerContextBudget(Number.NaN, 0.8)).toBe(8_000);
  });
});

describe("architectureSummary", () => {
  it("keeps every node when no budget is supplied", () => {
    const summary = architectureSummary(populatedSnapshot());

    expect(summary).toContain("l0:system");
    expect(summary).toContain("l1:29");
    expect(summary).toContain("facet:29");
    expect(summary).toContain("L1 (30):");
    expect(summary).toContain("Facets (30):");
    expect(summary).not.toContain("compacted");
  });

  it("compacts L1 and facets while preserving L0 anchors", () => {
    const summary = architectureSummary(populatedSnapshot(), 900);

    expect(summary).toContain("l0:system");
    expect(summary).toContain("l0:module");
    expect(summary).toContain("L1 (30):");
    expect(summary).toContain("Facets (30):");
    expect(summary).toMatch(/compacted \d+ L1 and \d+ facet nodes/);
    expect(summary).not.toContain("facet:29");
  });
});

describe("planWithProvider classification", () => {
  const config = {
    kind: "openai-compatible" as const,
    baseUrl: "https://provider.test/v1",
    model: "test-model",
    apiKey: null,
    reasoningEffort: "auto" as const,
    contextWindow: 128_000,
    compactionRatio: 0.8,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
  };

  async function withResponse(
    payload: Record<string, unknown>,
    run: (body: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const original = globalThis.fetch;
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      for (const key of Object.keys(requestBody)) delete requestBody[key];
      Object.assign(
        requestBody,
        JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
      );
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      await run(requestBody);
    } finally {
      globalThis.fetch = original;
    }
  }

  it("returns a conversational reply without creating a proposal", async () => {
    await withResponse({ kind: "chat", message: "Hello from the model." }, async () => {
      const draft = await planWithProvider(config, "Hi, how are you?", {
        snapshot: emptySnapshot(),
        skills: "",
        reuseSummary: "",
      });
      expect(draft.kind).toBe("chat");
      expect(draft.assistantMessage).toBe("Hello from the model.");
      expect(draft.ops).toEqual([]);
      expect(draft.nodeIntents).toEqual([]);
      expect(draft.tasks).toEqual([]);
    });
  });

  it("keeps planning behavior and passes recent history to the model", async () => {
    await withResponse(
      {
        kind: "plan",
        title: "Add a unit",
        goal: "Add the unit",
        message: "Review this change",
        tasks: [
          {
            title: "Add the unit",
            acceptance: ["The unit returns a value"],
            files: ["src/unit.ts", "src/unit.test.ts"],
            dependsOn: [],
          },
        ],
        nodeIntents: [],
        ops: [],
      },
      async (body) => {
        const draft = await planWithProvider(config, "Now add it", {
          snapshot: emptySnapshot(),
          skills: "",
          reuseSummary: "",
          history: [
            { role: "user", content: "We discussed a new unit." },
            { role: "assistant", content: "Understood." },
          ],
        });
        expect(draft.kind).toBe("plan");
        expect(draft.title).toBe("Add a unit");
        expect(draft.tasks[0]?.files).toEqual(["src/unit.ts", "src/unit.test.ts"]);
        const messages = body.messages as Array<{ role: string; content: string }>;
        const user = messages.find((message) => message.role === "user");
        expect(user?.content).toContain("Assistant: Understood.");
        expect(user?.content).toContain("Now add it");
      },
    );
  });

  it("injects AGENTS.md rules into the planning prompt", async () => {
    await withResponse(
      { kind: "plan", title: "T", goal: "G", ops: [], tasks: [], nodeIntents: [] },
      async (body) => {
        await planWithProvider(config, "Change it", {
          snapshot: emptySnapshot(),
          skills: "",
          reuseSummary: "",
          rules: "Always use pnpm. Never touch .jin/.",
        });
        const messages = body.messages as Array<{ role: string; content: string }>;
        const user = messages.find((message) => message.role === "user");
        expect(user?.content).toContain("Rules from AGENTS.md (must be respected):");
        expect(user?.content).toContain("Always use pnpm. Never touch .jin/.");
      },
    );
  });

  it("treats a response without a kind as a plan for compatibility", async () => {
    await withResponse({ title: "Legacy", goal: "Legacy plan", ops: [] }, async () => {
      const draft = await planWithProvider(config, "Change it", {
        snapshot: emptySnapshot(),
        skills: "",
        reuseSummary: "",
      });
      expect(draft.kind).toBe("plan");
      expect(draft.title).toBe("Legacy");
    });
  });

  it("unwraps a single nested container object", async () => {
    await withResponse(
      {
        data: {
          kind: "plan",
          title: "Wrapped",
          goal: "Wrapped goal",
          ops: [],
          nodeIntents: [],
          tasks: [],
        },
      },
      async () => {
        const draft = await planWithProvider(config, "Change it", {
          snapshot: emptySnapshot(),
          skills: "",
          reuseSummary: "",
        });
        expect(draft.kind).toBe("plan");
        expect(draft.title).toBe("Wrapped");
      },
    );
  });

  it("accepts common title/goal aliases", async () => {
    await withResponse(
      { kind: "plan", name: "Aliased", description: "Aliased goal", ops: [] },
      async () => {
        const draft = await planWithProvider(config, "Change it", {
          snapshot: emptySnapshot(),
          skills: "",
          reuseSummary: "",
        });
        expect(draft.kind).toBe("plan");
        expect(draft.title).toBe("Aliased");
        expect(draft.goal).toBe("Aliased goal");
      },
    );
  });

  it("repairs once when the first response lacks title and goal", async () => {
    const original = globalThis.fetch;
    const payloads = [
      { message: "Let me think about it." },
      { kind: "plan", title: "Repaired", goal: "Repaired goal", ops: [], tasks: [] },
    ];
    let call = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const payload = payloads[Math.min(call, payloads.length - 1)];
      call += 1;
      if (call === 2) {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        const messages = JSON.parse(rawBody).messages as Array<{
          content: string;
        }>;
        expect(messages[messages.length - 1]?.content).toContain("title");
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const draft = await planWithProvider(config, "Change it", {
        snapshot: emptySnapshot(),
        skills: "",
        reuseSummary: "",
      });
      expect(draft.kind).toBe("plan");
      expect(draft.title).toBe("Repaired");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports the raw model JSON when the schema still does not match", async () => {
    await withResponse({ kind: "plan", summary: "No title here" }, async () => {
      let failure: unknown;
      try {
        await planWithProvider(config, "Change it", {
          snapshot: emptySnapshot(),
          skills: "",
          reuseSummary: "",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as Error).message).toContain("missing title or goal");
      expect((failure as { details?: string }).details).toContain("No title here");
    });
  });
});
