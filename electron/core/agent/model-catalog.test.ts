import { createServer } from "node:http";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  fetchModelCatalog,
  modelEndpointCandidates,
  parseGeminiModelPayload,
  parseOllamaModelPayload,
  parseOpenAIModelPayload,
  reasoningEffortsForModel,
  resolveReasoningEfforts,
} from "./model-catalog";

describe("modelEndpointCandidates", () => {
  it("tries /models then /v1/models for a provider root", () => {
    expect(modelEndpointCandidates("openai-compatible", "http://127.0.0.1:1234")).toEqual([
      "http://127.0.0.1:1234/models",
      "http://127.0.0.1:1234/v1/models",
    ]);
  });

  it("does not duplicate a versioned or explicit model path", () => {
    expect(modelEndpointCandidates("openai-compatible", "https://api.test/v1")).toEqual([
      "https://api.test/v1/models",
    ]);
    expect(modelEndpointCandidates("openai-compatible", "https://api.test/v1/models")).toEqual([
      "https://api.test/v1/models",
    ]);
  });

  it("builds Ollama tags endpoints", () => {
    expect(modelEndpointCandidates("ollama", "http://127.0.0.1:11434")).toEqual([
      "http://127.0.0.1:11434/api/tags",
    ]);
    expect(modelEndpointCandidates("ollama", "http://127.0.0.1:11434/api")).toEqual([
      "http://127.0.0.1:11434/api/tags",
    ]);
    expect(modelEndpointCandidates("none", "http://127.0.0.1:11434")).toEqual([]);
  });

  it("builds the Gemini v1beta models endpoint", () => {
    expect(modelEndpointCandidates("gemini", "https://generativelanguage.googleapis.com")).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models",
    ]);
    expect(modelEndpointCandidates("gemini", "https://ai.test/v1beta")).toEqual([
      "https://ai.test/v1beta/models",
    ]);
  });

  it("rejects non-http URLs", () => {
    expect(() => modelEndpointCandidates("openai-compatible", "file:///tmp/models")).toThrow(
      /http/i,
    );
  });
});

describe("parseOpenAIModelPayload", () => {
  it("reads object lists, bare ids, capability hints, and context windows", () => {
    const models = parseOpenAIModelPayload({
      data: [
        {
          id: "gpt-5",
          name: "GPT-5",
          context_window: 400_000,
          supported_reasoning_efforts: ["low", "high"],
        },
        { id: "plain-chat", capabilities: { reasoning: false } },
        "bare-model",
        {
          id: "gpt-5",
          name: "GPT-5 duplicate",
          context_window: 400_000,
          supported_reasoning_efforts: ["low", "high"],
        },
      ],
    });
    expect(models.map((model) => model.id)).toEqual(["bare-model", "gpt-5", "plain-chat"]);
    const gpt = models.find((model) => model.id === "gpt-5");
    expect(gpt).toMatchObject({
      name: "GPT-5 duplicate",
      contextWindow: 400_000,
      reasoningEfforts: ["auto", "low", "high"],
    });
    expect(models.find((model) => model.id === "plain-chat")?.reasoningEfforts).toEqual(["auto"]);
  });

  it("accepts a bare array and a models wrapper", () => {
    expect(parseOpenAIModelPayload(["a", "b"]).map((model) => model.id)).toEqual(["a", "b"]);
    expect(parseOpenAIModelPayload({ models: [{ model: "custom/model" }] })[0]?.id).toBe(
      "custom/model",
    );
  });

  it("returns an empty list for malformed payloads", () => {
    expect(parseOpenAIModelPayload(null)).toEqual([]);
    expect(parseOpenAIModelPayload({ data: "nope" })).toEqual([]);
  });
});

describe("parseGeminiModelPayload", () => {
  it("strips the models/ path prefix and uses displayName as the label", () => {
    const models = parseGeminiModelPayload({
      models: [
        {
          name: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
        },
        { name: "models/gemini-2.5-flash" },
        "bare-entry",
        { displayName: "no name field" },
      ],
    });
    expect(models.map((model) => model.id).sort()).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(models.find((model) => model.id === "gemini-2.5-pro")).toMatchObject({
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      reasoningEfforts: ["auto", "low", "medium", "high"],
    });
    expect(models.find((model) => model.id === "gemini-2.5-flash")?.name).toBe("gemini-2.5-flash");
  });

  it("returns an empty list for malformed payloads", () => {
    expect(parseGeminiModelPayload(null)).toEqual([]);
    expect(parseGeminiModelPayload({ models: "nope" })).toEqual([]);
  });
});

describe("parseOllamaModelPayload", () => {
  it("reads names and context details", () => {
    const models = parseOllamaModelPayload({
      models: [
        {
          name: "qwen3:8b",
          details: { context_length: 32_768 },
        },
        { model: "llama3.2" },
      ],
    });
    expect(models).toEqual([
      expect.objectContaining({
        id: "llama3.2",
        reasoningEfforts: ["auto", "low", "medium", "high"],
      }),
      expect.objectContaining({
        id: "qwen3:8b",
        contextWindow: 32_768,
        reasoningEfforts: ["auto", "low", "medium", "high"],
      }),
    ]);
  });
});

describe("reasoningEffortsForModel", () => {
  it("prefers explicit capability metadata", () => {
    expect(
      reasoningEffortsForModel("unknown", {
        reasoning_efforts: ["medium"],
      }),
    ).toEqual(["auto", "medium"]);
    expect(reasoningEffortsForModel("o3-mini", { supports_reasoning: false })).toEqual(["auto"]);
  });

  it("recognizes common reasoning families", () => {
    expect(reasoningEffortsForModel("o3-mini")).toEqual(["auto", "low", "medium", "high"]);
    expect(reasoningEffortsForModel("deepseek-r1:8b")).toEqual(["auto", "low", "medium", "high"]);
  });
});

describe("remote capability metadata", () => {
  it("reads OpenRouter supported_parameters and nested effort lists", () => {
    expect(
      resolveReasoningEfforts("custom/model", {
        supported_parameters: ["tools", "reasoning"],
      }),
    ).toEqual({
      efforts: ["auto", "low", "medium", "high"],
      source: "remote",
    });
    expect(
      resolveReasoningEfforts("custom/model", {
        capabilities: { reasoning: { efforts: ["low", "high"] } },
      }),
    ).toEqual({ efforts: ["auto", "low", "high"], source: "remote" });
    expect(
      resolveReasoningEfforts("custom/model", {
        capabilities: { reasoning: false },
      }),
    ).toEqual({ efforts: ["auto"], source: "remote" });
  });

  it("normalizes provider aliases and reports inference provenance", () => {
    expect(
      resolveReasoningEfforts("custom/model", {
        supported_reasoning_efforts: ["minimal", "xhigh"],
      }),
    ).toEqual({ efforts: ["auto", "low", "high"], source: "remote" });
    expect(resolveReasoningEfforts("o3-mini")).toEqual({
      efforts: ["auto", "low", "medium", "high"],
      source: "inferred",
    });
    expect(resolveReasoningEfforts("plain-chat")).toEqual({
      efforts: ["auto", "low", "medium", "high"],
      source: "default",
    });
  });

  it("parses context windows from vLLM, LM Studio, and Ollama metadata", () => {
    const [vllm] = parseOpenAIModelPayload({
      data: [{ id: "vllm-model", max_model_len: 131_072 }],
    });
    expect(vllm?.contextWindow).toBe(131_072);
    const [lmStudio] = parseOpenAIModelPayload({
      data: [{ id: "local-model", max_context_length: "65536" }],
    });
    expect(lmStudio?.contextWindow).toBe(65_536);
    const [ollama] = parseOllamaModelPayload({
      models: [
        {
          name: "qwen3:8b",
          model_info: { "qwen3.context_length": 40_960 },
        },
      ],
    });
    expect(ollama?.contextWindow).toBe(40_960);
  });
});

describe("fetchModelCatalog", () => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [{ id: "test-model", context_length: 64_000 }],
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  afterAll(() => {
    server.close();
  });

  it("falls back to /v1/models and sends the supplied key", async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    let authorization = "";
    server.on("request", (request) => {
      authorization = request.headers.authorization ?? authorization;
    });
    const catalog = await fetchModelCatalog({
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
    });
    expect(authorization).toBe("Bearer test-key");
    expect(catalog.models).toEqual([
      expect.objectContaining({ id: "test-model", contextWindow: 64_000 }),
    ]);
    expect(catalog.warning).toBeUndefined();
  });

  it("enriches Ollama tags with /api/show capabilities and context", async () => {
    const ollama = createServer((request, response) => {
      if (request.url === "/api/tags") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
        return;
      }
      if (request.url === "/api/show" && request.method === "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            capabilities: ["completion", "thinking"],
            model_info: { "qwen3.context_length": 65_536 },
          }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
    try {
      await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
      const address = ollama.address();
      if (!address || typeof address === "string") throw new Error("no test port");
      const catalog = await fetchModelCatalog({
        kind: "ollama",
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
      expect(catalog.models).toEqual([
        expect.objectContaining({
          id: "qwen3:8b",
          contextWindow: 65_536,
          reasoningSource: "remote",
          reasoningEfforts: ["auto", "low", "medium", "high"],
        }),
      ]);
    } finally {
      ollama.close();
    }
  });
});
