import { describe, expect, it } from "vite-plus/test";
import {
  chooseCompaction,
  clipSummary,
  compactionThreshold,
  estimateMessagesTokens,
  estimateTokens,
  shouldCompact,
  splitForCompaction,
  summaryPrompt,
  trimConversation,
  type CompactionPolicy,
} from "./compaction";

describe("estimateMessagesTokens", () => {
  it("sums token estimates across messages", () => {
    expect(
      estimateMessagesTokens([
        { role: "user", content: "aaaa" },
        { role: "assistant", content: "bbbb" },
      ]),
    ).toBe(2);
  });
});

const policy: CompactionPolicy = { contextWindow: 100_000, ratio: 0.8, keepTurns: 2 };

describe("estimateTokens", () => {
  it("counts roughly a quarter of ASCII characters", () => {
    expect(estimateTokens("aaaa")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("shouldCompact", () => {
  it("trips when the conversation outgrows 45% of the usable budget", () => {
    const big = Array.from({ length: 4000 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: "x".repeat(400),
    }));
    expect(shouldCompact(big, policy)).toBe(true);
    expect(shouldCompact([], policy)).toBe(false);
  });
});

describe("splitForCompaction", () => {
  it("keeps whole turns and cuts on a user boundary", () => {
    const messages = [
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];
    const { older, recent } = splitForCompaction(messages, 2);
    expect(older.map((message) => message.content)).toEqual(["a0"]);
    expect(recent.map((message) => message.content)).toEqual(["u1", "a1", "u2", "a2"]);
  });
});

describe("trimConversation", () => {
  it("keeps user requests verbatim and clips assistant chatter to a tail", () => {
    const older = [
      { role: "user", content: "add a reset button" },
      { role: "assistant", content: "x".repeat(5_000) + " done and verified" },
    ];
    const text = trimConversation(older, { maxTurns: 40, assistantTailChars: 40 });
    expect(text).toContain("add a reset button");
    expect(text).toContain("done and verified");
    expect(text).not.toContain("x".repeat(5_000));
  });
});

describe("chooseCompaction", () => {
  it("prefers trim while the trimmed text fits the local budget", () => {
    const older = [
      { role: "user", content: "short" },
      { role: "assistant", content: "short" },
    ];
    expect(chooseCompaction(older, "auto", 10_000)).toBe("trim");
    expect(chooseCompaction(older, "llm", 10_000)).toBe("llm");
    expect(chooseCompaction([], "auto", 10)).toBe("none");
  });
});

describe("summarizers", () => {
  it("wraps a summary for planner injection and clips runaway output", () => {
    expect(summaryPrompt("abc")).toContain("abc");
    expect(summaryPrompt("  ")).toBe("");
    expect(clipSummary("z".repeat(40_000)).length).toBeLessThan(40_000);
    expect(compactionThreshold(policy)).toBeGreaterThan(0);
  });
});
