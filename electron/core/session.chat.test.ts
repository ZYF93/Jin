import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectSession, stoppedMessage } from "./session";
import type { SessionDeps } from "./session";
import { translate } from "../../shared/i18n";
import type { AppSettings, JinEvent } from "../../shared/ipc";
import type { ProviderConfig } from "./agent/provider";

process.env.JIN_QUIET = "1";

/** Mock SettingsStore surface used by ProjectSession. */
function mockSettings(
  provider: AppSettings["provider"] = {
    kind: "openai-compatible",
    baseUrl: "https://provider.test/v1",
    model: "test-model",
    hasApiKey: true,
  },
): unknown {
  return {
    get: () => ({
      language: "en",
      theme: "dark",
      glass: "subtle",
      provider,
      providerProfiles: [],
      agent: { semanticScan: false, temperature: 0.2, maxTokens: 8000, maxWorkers: 0 },
      identity: { actorId: "user:test", name: "tester", email: "" },
      ui: { reduceMotion: false },
      updates: { autoCheck: false, feedUrl: "" },
    }),
    isAgentConfigured: () => true,
    providerConfig: (): ProviderConfig => ({
      ...provider,
      apiKey: "test-key",
    }),
  };
}

function mockDeps(settings: unknown): {
  deps: SessionDeps;
  events: JinEvent[];
} {
  const events: JinEvent[] = [];
  const deps = {
    settings,
    recentProjects: () => [],
    emit: (event: JinEvent) => {
      events.push(event);
    },
  } as unknown as SessionDeps;
  return { deps, events };
}

interface SessionInternals {
  addMessage: (
    role: "user" | "assistant",
    kind: string,
    content: string,
    extra?: Record<string, unknown>,
  ) => { id: string };
  messages: Array<{ id: string; role: string; kind: string; content: string; proposalId?: string }>;
  checkpoints: Map<string, { hash: string; createdAt: string }>;
  lastCheckpointVersionId: string | null;
}

function internals(session: ProjectSession): SessionInternals {
  return session as unknown as SessionInternals;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join("/tmp", `jin-session-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(tmpDir, ".jin"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ProjectSession.deleteMessage (recall)", () => {
  it("rewinds the conversation to before the recalled user turn", () => {
    const { deps } = mockDeps(mockSettings());
    const session = ProjectSession.lightweight(deps, tmpDir);
    internals(session).addMessage("user", "text", "First question");
    internals(session).addMessage("assistant", "text", "First answer.");
    const userMessage = internals(session).addMessage("user", "text", "Do the thing");
    internals(session).addMessage("assistant", "text", "Done the thing.", { proposalId: "v-test" });
    internals(session).addMessage("user", "text", "Now change more");
    internals(session).addMessage("assistant", "text", "Changed more.");
    const ids = internals(session).messages.map((message) => message.id);
    expect(ids).toHaveLength(6);

    session.deleteMessage(userMessage.id);

    // Recalling a user turn removes it, its recorded answer, and every later
    // message — the conversation rewinds to the turn before it.
    expect(internals(session).messages.map((message) => message.id)).toEqual(ids.slice(0, 2));
  });

  it("removes an assistant message and everything after it", () => {
    const { deps, events } = mockDeps(mockSettings());
    const session = ProjectSession.lightweight(deps, tmpDir);
    internals(session).addMessage("user", "text", "Do the thing");
    const answer = internals(session).addMessage("assistant", "text", "Done.");
    internals(session).addMessage("user", "text", "More");
    const first = internals(session).messages[0]?.id;

    session.deleteMessage(answer.id);

    // The answer and all following messages are cut.
    expect(internals(session).messages).toHaveLength(1);
    expect(internals(session).messages[0]?.id).toBe(first);
    const deleteEvents = events.filter((event) => event.type === "chat-delete");
    expect(deleteEvents).toHaveLength(1);
    expect(deleteEvents[0]).toEqual({ type: "chat-delete", messageId: answer.id });
  });

  it("throws for an unknown message id", () => {
    const { deps } = mockDeps(mockSettings());
    const session = ProjectSession.lightweight(deps, tmpDir);
    internals(session).addMessage("user", "text", "Hello");
    expect(() => session.deleteMessage("01nope")).toThrow(
      translate("en", "error.messageNotFound", { id: "01nope" }),
    );
  });
});

vi.mock("./agent/checkpoint", async () => ({
  restoreCheckpoint: async (
    _root: string,
    _hash: string,
  ): Promise<{ restored: number; warnings: string[] }> => ({ restored: 3, warnings: [] }),
}));

describe("stoppedMessage", () => {
  it("keeps the partial stream text and appends the stopped marker", () => {
    expect(stoppedMessage("Half an answer", "Turn stopped.")).toBe(
      "Half an answer\n\nTurn stopped.",
    );
  });

  it("uses only the marker when nothing had streamed yet", () => {
    expect(stoppedMessage("", "Turn stopped.")).toBe("Turn stopped.");
    expect(stoppedMessage(undefined, "Turn stopped.")).toBe("Turn stopped.");
    expect(stoppedMessage("   \n ", "Turn stopped.")).toBe("Turn stopped.");
  });
});

describe("ProjectSession.undoLastImplementation", () => {
  it("is a silent no-op when no checkpoint exists", async () => {
    const { deps } = mockDeps(mockSettings());
    const session = ProjectSession.lightweight(deps, tmpDir);
    const state = await session.undoLastImplementation();
    expect(state.agent.phase).toBe("idle");
    expect(internals(session).checkpoints.size).toBe(0);
  });

  it("is a no-op when the requested version has no checkpoint", async () => {
    const { deps } = mockDeps(mockSettings());
    const session = ProjectSession.lightweight(deps, tmpDir);
    const state = await session.undoLastImplementation("v-missing");
    expect(state.agent.phase).toBe("idle");
  });

  it("restores the checkpoint when one exists for the version", async () => {
    const { deps } = mockDeps(mockSettings());
    const session = ProjectSession.lightweight(deps, tmpDir);
    internals(session).checkpoints.set("v1", {
      hash: "abc12345deadbeef",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    internals(session).lastCheckpointVersionId = "v1";
    const state = await session.undoLastImplementation("v1");
    const restored = state.messages.find(
      (message) => message.role === "system" && message.kind === "text",
    );
    expect(restored?.content).toContain("Restored");
    expect(restored?.content).toContain("abc12345dead");
    expect(internals(session).checkpoints.has("v1")).toBe(false);
    expect(state.agent.phase).toBe("idle");
  });
});
