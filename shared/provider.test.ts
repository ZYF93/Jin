import { describe, expect, it } from "vite-plus/test";
import { isProviderConfigured } from "./provider";

describe("isProviderConfigured", () => {
  it("rejects missing, empty, and explicitly disabled providers", () => {
    expect(isProviderConfigured(null)).toBe(false);
    expect(isProviderConfigured(undefined)).toBe(false);
    expect(
      isProviderConfigured({ kind: "none", baseUrl: "", model: "" }),
    ).toBe(false);
    expect(
      isProviderConfigured({
        kind: "none",
        baseUrl: "https://api.example/v1",
        model: "example",
      }),
    ).toBe(false);
  });

  it("requires both an endpoint and a model", () => {
    expect(
      isProviderConfigured({
        kind: "openai-compatible",
        baseUrl: "https://api.example/v1",
        model: "",
      }),
    ).toBe(false);
    expect(
      isProviderConfigured({
        kind: "openai-compatible",
        baseUrl: "   ",
        model: "example",
      }),
    ).toBe(false);
  });

  it("accepts local anonymous OpenAI-compatible and Ollama providers", () => {
    expect(
      isProviderConfigured({
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-model",
      }),
    ).toBe(true);
    expect(
      isProviderConfigured({
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3:8b",
      }),
    ).toBe(true);
  });
});
