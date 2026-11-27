import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectSession } from "./session";
import type { SessionDeps } from "./session";
import { RagService } from "./rag/rag";
import type { JinEvent } from "../../shared/ipc";
import type { ProviderConfig } from "./agent/provider";
import type { ArchitectureDesignInput, ArchitectureDesignResult } from "./scan/arch-agent";

process.env.JIN_QUIET = "1";

function mockSettings(): unknown {
  return {
    get: () => ({
      language: "en",
      theme: "dark",
      glass: "subtle",
      provider: {
        kind: "openai-compatible",
        baseUrl: "https://provider.test/v1",
        model: "test-model",
        hasApiKey: true,
      },
      providerProfiles: [],
      agent: { semanticScan: true, temperature: 0.2, maxTokens: 8000, maxWorkers: 0 },
      identity: { actorId: "user:test", name: "tester", email: "" },
      ui: { reduceMotion: false },
      updates: { autoCheck: false, feedUrl: "" },
    }),
    isAgentConfigured: () => true,
    providerConfig: (): ProviderConfig => ({
      kind: "openai-compatible",
      baseUrl: "https://provider.test/v1",
      model: "test-model",
      apiKey: "test-key",
    }),
  };
}

/**
 * A deterministic architecture designer for tests. When `fillAll` is true it
 * gives every scanned node a responsibility; otherwise it leaves L1/facet
 * nodes undescribed (empty) to exercise the "incomplete" path.
 */
function makeDesigner(
  fillAll: boolean,
): (input: ArchitectureDesignInput) => Promise<ArchitectureDesignResult> {
  return async (input) => {
    const scan = input.scan;
    const nodes = scan.nodes.map((node) => {
      if (node.kind === "system" || node.kind === "external") return node;
      const responsibility = fillAll
        ? `${node.name} does what it says for the system.`
        : node.level === "L0"
          ? "Coordinates its children."
          : "";
      return { ...node, responsibility, metadata: { ...node.metadata, semantic: true } };
    });
    const files = scan.files.map((file) =>
      fillAll ? { ...file, responsibility: `${file.title} role.` } : file,
    );
    const unrefined = !fillAll;
    return {
      scan: { ...scan, nodes, files },
      designed: nodes,
      warnings: [],
      applied: true,
      summary: unrefined ? "partial" : "complete",
    } as unknown as ArchitectureDesignResult;
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join("/tmp", `jin-first-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(tmpDir, ".jin"), { recursive: true });
  mkdirSync(join(tmpDir, "src"), { recursive: true });
  writeFileSync(
    join(tmpDir, "src", "index.ts"),
    "export function mount() {\n  return 'app';\n}\n",
    "utf8",
  );
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeSession(
  designer: (input: ArchitectureDesignInput) => Promise<ArchitectureDesignResult>,
): ProjectSession {
  const events: JinEvent[] = [];
  const deps = {
    settings: mockSettings(),
    recentProjects: () => [],
    emit: (event: JinEvent) => events.push(event),
    marketplace: { specs: () => [] },
    designArchitecture: designer,
  } as unknown as SessionDeps;
  const session = ProjectSession.lightweight(deps, tmpDir);
  (session as unknown as { marketplace: unknown }).marketplace = { specs: () => [] };
  (session as unknown as { rag: RagService }).rag = new RagService(null);
  return session;
}

describe("first scan via architecture design agent", () => {
  it("establishes the architecture without a reject step when fully designed", async () => {
    const session = makeSession(makeDesigner(true));
    await session.scan();
    const state = session.getState() as {
      scan: { firstScanComplete: boolean; semanticRetryPending: boolean };
    };
    expect(state.scan.firstScanComplete).toBe(true);
    expect(state.scan.semanticRetryPending).toBe(false);
    // No proposal left in review (a complete first scan is committed directly).
    expect((session as unknown as { proposal: unknown }).proposal ?? null).toBe(null);
    // Node responsibilities carry the LLM text, not an empty/local template.
    const nodes = (
      session as unknown as {
        snapshot: { nodes: Record<string, { level: string; responsibility: string }> };
      }
    ).snapshot.nodes;
    const l1 = Object.values(nodes).find((node) => node.level === "L1");
    expect(l1?.responsibility).toBeTruthy();
  });

  it("blocks chat and flags a retry when the design left nodes undescribed", async () => {
    const session = makeSession(makeDesigner(false));
    await session.scan();
    const state = session.getState() as {
      scan: { firstScanComplete: boolean; semanticRetryPending: boolean };
    };
    expect(state.scan.firstScanComplete).toBe(false);
    expect(state.scan.semanticRetryPending).toBe(true);
    await expect(session.sendMessage("hello")).rejects.toThrow(/first scan/i);
  });

  it("lets a retry complete the first scan and unlock chat", async () => {
    // First scan leaves L1/facet undescribed.
    const session = makeSession(makeDesigner(false));
    await session.scan();
    expect(
      (session.getState() as { scan: { firstScanComplete: boolean } }).scan.firstScanComplete,
    ).toBe(false);

    // A successful retry (all filled) establishes the architecture.
    const retryable = session as unknown as {
      pendingSemanticUnrefined: unknown;
      designArchitecture: (input: ArchitectureDesignInput) => Promise<ArchitectureDesignResult>;
    };
    const deps = retryable as unknown as { deps: { designArchitecture?: unknown } };
    deps.deps.designArchitecture = makeDesigner(true);
    await session.retrySemantic();
    expect(
      (session.getState() as { scan: { firstScanComplete: boolean } }).scan.firstScanComplete,
    ).toBe(true);
  });
});
