import { describe, expect, it } from "vite-plus/test";
import { presetFor } from "./model-presets";

describe("presetFor", () => {
  it("matches families by longest prefix", () => {
    expect(presetFor("deepseek-v4.1-flash")?.inputPricePerMillion).toBe(0.15);
    expect(presetFor("gpt-6.1-terra")?.contextWindow).toBe(1_050_000);
    expect(presetFor("glm-5.3-flashx")?.vision).toBe(true);
    expect(presetFor("qwen3.8-max")?.vision).toBe(true);
  });

  it("resolves dated or suffixed ids to their family", () => {
    expect(presetFor("claude-opus-5.5-20260922")?.inputPricePerMillion).toBe(4);
    expect(presetFor("kimi-k3.1-pro")?.contextWindow).toBe(1_048_576);
  });

  it("returns null for unknown models", () => {
    expect(presetFor("totally-unknown-model-xyz")).toBeNull();
    expect(presetFor("")).toBeNull();
  });

  it("prefers a longer, more specific match over a prefix", () => {
    expect(presetFor("gpt-5-mini")?.contextWindow).toBe(400_000);
    expect(presetFor("gpt-5")?.contextWindow).toBe(400_000);
  });
});
