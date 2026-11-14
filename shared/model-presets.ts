/**
 * Built-in model metadata. Providers rarely advertise context windows or
 * prices, so Jin fills the gaps from this table: the composer meter, the
 * compaction threshold and the cost panel all read these values.
 *
 * Matching is by exact id first, then by longest prefix (so dated snapshots
 * like `gpt-4o-2024-08-06` resolve to the family entry).
 */
export interface ModelPreset {
  /** Exact model id or id prefix. */
  match: string;
  contextWindow: number;
  /** USD per million prompt tokens. */
  inputPricePerMillion?: number;
  /** USD per million completion tokens. */
  outputPricePerMillion?: number;
  /** Accepts image input. */
  vision?: boolean;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  // OpenAI GPT-6 / GPT-6.1 (2026) — flagship tiers
  {
    match: "gpt-6.1-sol",
    contextWindow: 1_050_000,
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "gpt-6.1-terra",
    contextWindow: 1_050_000,
    inputPricePerMillion: 1,
    outputPricePerMillion: 5,
    vision: true,
  },
  {
    match: "gpt-6.1",
    contextWindow: 1_050_000,
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "gpt-6-sol",
    contextWindow: 1_050_000,
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "gpt-6-terra",
    contextWindow: 1_050_000,
    inputPricePerMillion: 1,
    outputPricePerMillion: 5,
    vision: true,
  },
  {
    match: "gpt-6-luna",
    contextWindow: 1_050_000,
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.5,
    vision: true,
  },
  {
    match: "gpt-6",
    contextWindow: 1_050_000,
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "gpt-5.6",
    contextWindow: 1_050_000,
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "gpt-5.5",
    contextWindow: 1_047_576,
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    vision: true,
  },
  // OpenAI
  {
    match: "gpt-5",
    contextWindow: 400_000,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "gpt-5-mini",
    contextWindow: 400_000,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 2,
    vision: true,
  },
  {
    match: "gpt-5-nano",
    contextWindow: 400_000,
    inputPricePerMillion: 0.05,
    outputPricePerMillion: 0.4,
    vision: true,
  },
  {
    match: "gpt-4.1",
    contextWindow: 1_047_576,
    inputPricePerMillion: 2,
    outputPricePerMillion: 8,
    vision: true,
  },
  {
    match: "gpt-4.1-mini",
    contextWindow: 1_047_576,
    inputPricePerMillion: 0.4,
    outputPricePerMillion: 1.6,
    vision: true,
  },
  {
    match: "gpt-4o",
    contextWindow: 128_000,
    inputPricePerMillion: 2.5,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "gpt-4o-mini",
    contextWindow: 128_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6,
    vision: true,
  },
  {
    match: "o3",
    contextWindow: 200_000,
    inputPricePerMillion: 2,
    outputPricePerMillion: 8,
    vision: true,
  },
  {
    match: "o4-mini",
    contextWindow: 200_000,
    inputPricePerMillion: 1.1,
    outputPricePerMillion: 4.4,
    vision: true,
  },

  // Anthropic
  {
    match: "claude-fable-5.2",
    contextWindow: 1_048_576,
    inputPricePerMillion: 8,
    outputPricePerMillion: 40,
    vision: true,
  },
  {
    match: "claude-opus-5.5",
    contextWindow: 1_048_576,
    inputPricePerMillion: 4,
    outputPricePerMillion: 20,
    vision: true,
  },
  {
    match: "claude-sonnet-5.5",
    contextWindow: 1_048_576,
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "claude-haiku-5.5",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.5,
    vision: true,
  },
  {
    match: "claude-opus-4",
    contextWindow: 200_000,
    inputPricePerMillion: 15,
    outputPricePerMillion: 75,
    vision: true,
  },
  {
    match: "claude-sonnet-4",
    contextWindow: 200_000,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    vision: true,
  },
  {
    match: "claude-haiku-4",
    contextWindow: 200_000,
    inputPricePerMillion: 1,
    outputPricePerMillion: 5,
    vision: true,
  },
  {
    match: "claude-3-7-sonnet",
    contextWindow: 200_000,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    vision: true,
  },
  {
    match: "claude-3-5-sonnet",
    contextWindow: 200_000,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    vision: true,
  },
  {
    match: "claude-3-5-haiku",
    contextWindow: 200_000,
    inputPricePerMillion: 0.8,
    outputPricePerMillion: 4,
    vision: true,
  },
  {
    match: "claude-3-opus",
    contextWindow: 200_000,
    inputPricePerMillion: 15,
    outputPricePerMillion: 75,
    vision: true,
  },

  // Google
  {
    match: "gemini-4",
    contextWindow: 1_048_576,
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "gemini-3.8",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.75,
    outputPricePerMillion: 3.75,
    vision: true,
  },
  {
    match: "gemini-3.7",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.75,
    outputPricePerMillion: 3.75,
    vision: true,
  },
  {
    match: "gemini-3.5",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.3,
    outputPricePerMillion: 2.5,
    vision: true,
  },
  {
    match: "gemini-2.5-pro",
    contextWindow: 1_048_576,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "gemini-2.5-flash",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.3,
    outputPricePerMillion: 2.5,
    vision: true,
  },
  {
    match: "gemini-2.5-flash-lite",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.4,
    vision: true,
  },
  {
    match: "gemini-2.0-flash",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.4,
    vision: true,
  },

  // DeepSeek / Qwen / GLM / Kimi (OpenAI-compatible endpoints) — 2026 lineup
  {
    match: "deepseek-v4.1-flash",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6,
    vision: true,
  },
  {
    match: "deepseek-v4.1",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6,
    vision: true,
  },
  {
    match: "deepseek-v4-flash",
    contextWindow: 1_000_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6,
    vision: true,
  },
  {
    match: "deepseek-v4",
    contextWindow: 1_000_000,
    inputPricePerMillion: 0.66,
    outputPricePerMillion: 1.98,
  },
  {
    match: "deepseek-v3.2",
    contextWindow: 128_000,
    inputPricePerMillion: 0.19,
    outputPricePerMillion: 0.28,
  },
  {
    match: "deepseek-chat",
    contextWindow: 128_000,
    inputPricePerMillion: 0.27,
    outputPricePerMillion: 1.1,
  },
  {
    match: "deepseek-reasoner",
    contextWindow: 128_000,
    inputPricePerMillion: 0.55,
    outputPricePerMillion: 2.19,
  },
  {
    match: "glm-5.3-flashx",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.37,
    outputPricePerMillion: 1.25,
    vision: true,
  },
  {
    match: "glm-5.3-flash",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.5,
    vision: true,
  },
  {
    match: "glm-5.3",
    contextWindow: 1_048_576,
    inputPricePerMillion: 1.4,
    outputPricePerMillion: 4.4,
  },
  {
    match: "glm-5",
    contextWindow: 1_048_576,
    inputPricePerMillion: 1.4,
    outputPricePerMillion: 4.4,
  },
  {
    match: "glm-4.6",
    contextWindow: 200_000,
    inputPricePerMillion: 0.6,
    outputPricePerMillion: 2.2,
  },
  {
    match: "glm-4.5",
    contextWindow: 128_000,
    inputPricePerMillion: 0.6,
    outputPricePerMillion: 2.2,
  },
  {
    match: "kimi-k3.1",
    contextWindow: 1_048_576,
    inputPricePerMillion: 2,
    outputPricePerMillion: 10,
    vision: true,
  },
  {
    match: "kimi-k3",
    contextWindow: 1_048_576,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    vision: true,
  },
  {
    match: "kimi-k2.7-code",
    contextWindow: 262_144,
    inputPricePerMillion: 0.64,
    outputPricePerMillion: 3.15,
  },
  {
    match: "kimi-k2",
    contextWindow: 256_000,
    inputPricePerMillion: 0.6,
    outputPricePerMillion: 2.5,
  },
  {
    match: "qwen3.8",
    contextWindow: 1_048_576,
    inputPricePerMillion: 2,
    outputPricePerMillion: 6,
    vision: true,
  },
  {
    match: "qwen3.7",
    contextWindow: 1_048_576,
    inputPricePerMillion: 0.4,
    outputPricePerMillion: 1.6,
  },
  {
    match: "qwen3-coder",
    contextWindow: 256_000,
    inputPricePerMillion: 0.3,
    outputPricePerMillion: 1.2,
  },
  { match: "qwen3", contextWindow: 128_000 },

  // Local / open weights (rough defaults; local servers usually report none)
  { match: "llama", contextWindow: 128_000 },
  { match: "mistral", contextWindow: 128_000 },
  { match: "gemma", contextWindow: 128_000 },
  { match: "phi", contextWindow: 128_000 },
];

/** Longest-prefix match so families beat generic entries (e.g. gpt-4o-mini over gpt-4o). */
export function presetFor(modelId: string): ModelPreset | null {
  const id = modelId.trim().toLowerCase();
  if (!id) return null;
  const exact = MODEL_PRESETS.find((preset) => preset.match.toLowerCase() === id);
  if (exact) return exact;
  let best: ModelPreset | null = null;
  for (const preset of MODEL_PRESETS) {
    const prefix = preset.match.toLowerCase();
    if (id.startsWith(prefix) && (!best || prefix.length > best.match.length)) best = preset;
  }
  return best;
}
