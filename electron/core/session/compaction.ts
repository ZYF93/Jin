import { ProviderError, completeText, type ProviderConfig } from "../agent/provider";

/** Rough token estimate: 4 characters per token is close enough for budgeting. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // CJK text packs closer to 1 token per character; blend both estimates.
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 0.9 + other / 4);
}

export interface CompactableMessage {
  role: string;
  content: string;
}

export function estimateMessagesTokens(messages: readonly CompactableMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

export interface CompactionPolicy {
  /** Model context window in tokens. */
  contextWindow: number;
  /** Fraction of the context window Jin is allowed to fill. */
  ratio: number;
  /** Recent turns kept verbatim (a turn is a user message plus replies). */
  keepTurns: number;
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  contextWindow: 128_000,
  ratio: 0.8,
  keepTurns: 8,
};

/**
 * Conversation budget. The architecture snapshot, skills and AGENTS.md consume
 * a large, fixed share of the window, so compaction starts well before the raw
 * model limit: at 45% of the usable budget.
 */
export function compactionThreshold(policy: CompactionPolicy): number {
  const usable = Math.max(0, policy.contextWindow) * Math.min(1, Math.max(0.1, policy.ratio));
  return Math.max(6_000, Math.floor(usable * 0.45));
}

/** True when the recent history alone has outgrown the conversation budget. */
export function shouldCompact(
  messages: readonly CompactableMessage[],
  policy: CompactionPolicy,
): boolean {
  return estimateMessagesTokens(messages) > compactionThreshold(policy);
}

/**
 * Split messages into the part to summarize and the recent turns to keep. A
 * turn boundary is a user message; summaries always start at one so the kept
 * history reads as a coherent conversation.
 */
export function splitForCompaction<T extends CompactableMessage>(
  messages: readonly T[],
  keepTurns: number,
): { older: T[]; recent: T[] } {
  if (messages.length === 0) return { older: [], recent: [] };
  const keep = Math.max(1, keepTurns);
  let userTurns = 0;
  let cut = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    userTurns += 1;
    if (userTurns >= keep) {
      cut = index;
      break;
    }
  }
  return { older: messages.slice(0, cut), recent: messages.slice(cut) };
}

const SUMMARY_INSTRUCTIONS = `You are compacting a coding-assistant conversation so it fits a smaller context window.
Write a factual handoff summary for the next turn. Use these exact sections, in this order, and nothing else:

## Goal
What the user is trying to achieve, in 1-3 sentences.

## Decisions
Decisions, constraints and conventions agreed so far (one per line, newest last). Include explicit user preferences.

## Work completed
Files created or changed, commands run, and their outcomes.

## Open questions
Unresolved problems, failing tests, or choices the user must still make.

## Next steps
What the assistant was about to do next.

Keep every concrete detail (paths, symbols, commands, numbers). Omit pleasantries and repetition. Do not invent facts.`;

/** Ask the model to summarize the older half of a conversation. */
export async function summarizeConversation(
  config: ProviderConfig,
  older: readonly CompactableMessage[],
  options: { signal?: AbortSignal; phase?: string } = {},
): Promise<string> {
  const transcript = older
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");
  return completeText(config, SUMMARY_INSTRUCTIONS, transcript, {
    temperature: 0.1,
    maxTokens: 2_000,
    signal: options.signal,
    phase: options.phase ?? "compact",
    timeoutMs: 90_000,
  });
}

/** Render the stored summary for injection into planner prompts. */
export function summaryPrompt(summary: string): string {
  return summary.trim()
    ? `Earlier conversation, compacted to a handoff summary:\n${summary.trim()}`
    : "";
}

export type CompactionMode = "trim" | "llm" | "auto";

/**
 * Local, model-free reduction of the older half of a conversation. Used when
 * the context is over budget but the model cannot (or should not) be trusted
 * to write a summary — e.g. no provider key, offline, or the user prefers
 * determinism. It keeps: user requests verbatim, proposal conclusions, and a
 * clipped assistant tail; it drops the long assistant reasoning/tool chatter
 * in between.
 */
export function trimConversation(
  older: readonly CompactableMessage[],
  options?: { maxTurns?: number; assistantTailChars?: number },
): string {
  const maxTurns = Math.max(2, Math.min(100, options?.maxTurns ?? 40));
  const tail = Math.max(0, Math.min(8_000, options?.assistantTailChars ?? 900));
  const userLines: string[] = [];
  const assistantLines: string[] = [];
  for (const message of older) {
    const content = message.content.trim();
    if (!content) continue;
    if (message.role === "user") {
      userLines.push(content);
    } else {
      // Keep only the tail of each assistant turn: that is where the result
      // and decision live; the head is tool chatter / reasoning.
      const clipped = content.length > tail ? `…${content.slice(-tail)}` : content;
      assistantLines.push(clipped);
    }
  }
  const trimmedUser = userLines.slice(-maxTurns);
  const droppedUser = userLines.length - trimmedUser.length;
  const parts: string[] = [
    `Earlier conversation, locally trimmed (no model summary): ${older.length} messages reduced to ${trimmedUser.length} user turns and ${assistantLines.length} clipped assistant notes.`,
  ];
  if (droppedUser > 0) parts.push(`${droppedUser} older user turns were dropped.`);
  if (trimmedUser.length > 0)
    parts.push("User requests (newest last):", ...trimmedUser.map((line) => `- ${line}`));
  if (assistantLines.length > 0)
    parts.push(
      "Assistant notes (tails only, in order):",
      ...assistantLines.map((line) => `- ${line}`),
    );
  return parts.join("\n");
}

/**
 * Pick a compaction strategy. `auto` trims locally first and only escalates to
 * an LLM summary when the trimmed text is still over the local budget — this
 * is the "trim until it cannot shrink further, then summarize" behavior.
 */
export function chooseCompaction(
  older: readonly CompactableMessage[],
  mode: CompactionMode,
  localBudget: number,
): "none" | "trim" | "llm" {
  if (older.length === 0) return "none";
  if (mode === "llm") return "llm";
  if (mode === "trim") return "trim";
  const trimmed = trimConversation(older, { maxTurns: 40, assistantTailChars: 900 });
  return estimateTokens(trimmed) <= localBudget ? "trim" : "llm";
}
/** Cap the summary so a runaway model cannot reintroduce a huge context. */
export function clipSummary(summary: string, maxChars = 24_000): string {
  const clean = summary.trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}\n… [summary truncated]` : clean;
}

export { ProviderError };
