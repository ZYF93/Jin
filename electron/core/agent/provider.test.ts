import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderError,
  completeJson,
  completeText,
  consumeToolsUnsupportedHint,
  extractReasoningDelta,
  extractUsage,
  isToolCallRejection,
  requestHasTools,
  resilientProviderFetch,
  type ProviderConfig,
  type ProviderTokenUsage,
} from "./provider";

process.env.JIN_QUIET = "1";

describe("extractUsage", () => {
  it("reads OpenAI chat-completion usage", () => {
    expect(
      extractUsage({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
      }),
    ).toEqual({ promptTokens: 1200, completionTokens: 300 });
  });

  it("reads Ollama token counters", () => {
    expect(extractUsage({ response: "ok", prompt_eval_count: 90, eval_count: 12 })).toEqual({
      promptTokens: 90,
      completionTokens: 12,
    });
  });

  it("returns null when the provider reports no tokens", () => {
    expect(extractUsage({ choices: [{ message: { content: "ok" } }] })).toBeNull();
    expect(extractUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } })).toBeNull();
    expect(extractUsage(null)).toBeNull();
  });
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    kind: "openai-compatible",
    baseUrl: "https://provider.test/v1",
    model: "test-model",
    apiKey: "secret",
    ...overrides,
  };
}

function success(content: string, usage?: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      ...(usage ? { usage } : {}),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("provider request options", () => {
  it("sends the configured reasoning effort", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(requestBody(init));
      return success("ok");
    }) as typeof fetch;

    await completeText(config({ reasoningEffort: "high" }), "system", "user");

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.reasoning_effort).toBe("high");
    expect(bodies[0]).not.toHaveProperty("response_format");
  });

  it("omits auto reasoning effort", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(requestBody(init));
      return success("ok");
    }) as typeof fetch;

    await completeText(config({ reasoningEffort: "auto" }), "system", "user");

    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it("retries without response_format and reasoning_effort on HTTP 400", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      const body = requestBody(init);
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response("response_format unsupported", {
          status: 400,
          statusText: "Bad Request",
        });
      }
      if (bodies.length === 2) {
        return new Response("reasoning_effort unsupported", {
          status: 400,
          statusText: "Bad Request",
        });
      }
      return success('{"ok":true}');
    }) as typeof fetch;

    const result = await completeJson(config({ reasoningEffort: "medium" }), "system", "user");

    expect(result).toEqual({ ok: true });
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.response_format).toEqual({ type: "json_object" });
    expect(bodies[0]?.reasoning_effort).toBe("medium");
    expect(bodies[1]).not.toHaveProperty("response_format");
    expect(bodies[1]?.reasoning_effort).toBe("medium");
    expect(bodies[2]).not.toHaveProperty("response_format");
    expect(bodies[2]).not.toHaveProperty("reasoning_effort");
  });

  it("reports token usage and retries transient server failures", async () => {
    const usage: ProviderTokenUsage[] = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return success("fine", {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
      });
    }) as typeof fetch;

    const text = await completeText(config(), "system", "user", {
      onUsage: (value) => usage.push(value),
    });

    expect(text).toBe("fine");
    expect(calls).toBe(1);
    expect(usage).toEqual([{ promptTokens: 120, completionTokens: 30 }]);

    let failures = 0;
    globalThis.fetch = (async () => {
      failures += 1;
      return new Response("server exploded", {
        status: 500,
        statusText: "Server Error",
      });
    }) as typeof fetch;
    await expect(completeText(config(), "system", "user")).rejects.toThrow(
      /Provider 500 Server Error: server exploded/,
    );
    expect(failures).toBe(3);
  });

  it("retries network failures and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("network unavailable");
      return success("recovered");
    }) as typeof fetch;

    const result = completeText(
      config({ baseUrl: "https://retry-once.provider.test/v1" }),
      "system",
      "user",
    );
    const recovered = expect(result).resolves.toBe("recovered");
    await vi.advanceTimersByTimeAsync(300);

    await recovered;
    expect(calls).toBe(2);
  });

  it("retries rate-limit responses", async () => {
    vi.useFakeTimers();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return success("available");
    }) as typeof fetch;

    const result = completeText(
      config({ baseUrl: "https://rate-limited.provider.test/v1" }),
      "system",
      "user",
    );
    const recovered = expect(result).resolves.toBe("available");
    await vi.advanceTimersByTimeAsync(300);

    await recovered;
    expect(calls).toBe(2);
  });

  it("summarizes structured 429 errors and preserves raw diagnostics", async () => {
    vi.useFakeTimers();
    const raw = JSON.stringify({
      error: { message: "upstream temporarily rate-limited" },
      provider_name: "Phala",
      metadata: { raw: "request id 123" },
    });
    globalThis.fetch = (async () =>
      new Response(raw, { status: 429, statusText: "Too Many Requests" })) as typeof fetch;

    const result = completeText(
      config({ baseUrl: "https://structured-429.provider.test/v1" }),
      "system",
      "user",
    );
    const rejected = expect(result).rejects.toMatchObject({
      message: expect.stringContaining("rate limit reached at Phala (429)"),
      status: 429,
      providerName: "Phala",
      details: expect.stringContaining("request id 123"),
    });
    await vi.advanceTimersByTimeAsync(1_100);
    await rejected;
  });

  it("opens a circuit after three exhausted requests and rejects calls until cooldown", async () => {
    vi.useFakeTimers();
    const baseUrl = "https://circuit.provider.test/v1";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new TypeError("network unavailable");
    }) as typeof fetch;

    const failedRequest = () => completeText(config({ baseUrl }), "system", "user");
    for (let request = 0; request < 3; request += 1) {
      const result = failedRequest();
      const rejected = expect(result).rejects.toThrow(/network unavailable/);
      await vi.advanceTimersByTimeAsync(1_100);
      await rejected;
    }
    expect(calls).toBe(9);

    await expect(failedRequest()).rejects.toMatchObject({ retryAfterSeconds: 30 });
    expect(calls).toBe(9);

    vi.advanceTimersByTime(30_000);
    globalThis.fetch = (async () => success("recovered")) as typeof fetch;
    const recovery = failedRequest();
    const recovered = expect(recovery).resolves.toBe("recovered");
    await vi.advanceTimersByTimeAsync(1_100);
    await recovered;
  });
});

/** Build a text/event-stream Response that emits the given SSE blocks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const EMPTY_STREAM = [
  'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n',
  "data: [DONE]\n\n",
];

const REASONING_ONLY_STREAM = [
  'data: {"model":"reasoner-1","choices":[{"delta":{"reasoning_content":"thinking..."},"finish_reason":null}]}\n\n',
  'data: {"model":"reasoner-1","choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
  "data: [DONE]\n\n",
];

describe("empty provider streams", () => {
  it("retries an empty stream once and succeeds", async () => {
    let calls = 0;
    const deltas: string[] = [];
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return sseResponse(EMPTY_STREAM);
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }) as typeof fetch;

    const text = await completeText(config(), "system", "user", {
      onDelta: (delta) => deltas.push(delta),
    });

    expect(text).toBe("hello");
    expect(calls).toBe(2);
    expect(deltas).toEqual(["hello"]);
  });

  it("fails with stream diagnostics after the retry also returns no text", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return sseResponse(REASONING_ONLY_STREAM);
    }) as typeof fetch;

    let failure: ProviderErrorLike | undefined;
    try {
      await completeText(config(), "system", "user", { onDelta: () => undefined });
    } catch (error) {
      failure = error as ProviderErrorLike;
    }

    expect(calls).toBe(2);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe("Provider stream returned no text");
    expect(failure?.details).toContain("reasoning text: 11 chars (field: reasoning_content)");
    expect(failure?.details).toContain("finish_reason: length");
    expect(failure?.details).toContain("model: reasoner-1");
  });

  it("retries a JSON body with empty content once, then fails with the raw body", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let failure: ProviderErrorLike | undefined;
    try {
      await completeText(config(), "system", "user");
    } catch (error) {
      failure = error as ProviderErrorLike;
    }

    expect(calls).toBe(2);
    expect(failure?.message).toContain("no text");
    expect(failure?.details).toContain("single JSON body");
  });
});

interface ProviderErrorLike extends Error {
  details?: string;
}

describe("tool call rejection detection", () => {
  it("flags only sentences that pair a tool term with a rejection term", () => {
    expect(isToolCallRejection("This model does not support tool calls.")).toBe(true);
    expect(isToolCallRejection("400 Bad Request: tools are not enabled for this model")).toBe(true);
    expect(isToolCallRejection("function calling is unavailable on this endpoint")).toBe(true);
    expect(isToolCallRejection("Invalid API key.")).toBe(false);
    expect(isToolCallRejection("rate limited; retry later")).toBe(false);
    expect(isToolCallRejection("")).toBe(false);
  });

  it("detects a tools array in request bodies", () => {
    expect(
      requestHasTools(JSON.stringify({ model: "m", messages: [], tools: [{ type: "function" }] })),
    ).toBe(true);
    expect(requestHasTools(JSON.stringify({ model: "m", messages: [] }))).toBe(false);
    expect(requestHasTools(undefined)).toBe(false);
    expect(requestHasTools("not json")).toBe(false);
  });

  it("fails fast with a tagged error when the provider rejects tools", async () => {
    const toolsBody = JSON.stringify({
      model: "plain-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    globalThis.fetch = (async () =>
      new Response("400 This model does not support tool calls.", { status: 400 })) as typeof fetch;

    let failure: ProviderErrorLike | undefined;
    try {
      await resilientProviderFetch("https://fc-reject.test/v1/chat/completions", {
        method: "POST",
        body: toolsBody,
      });
    } catch (error) {
      failure = error as ProviderErrorLike;
    }

    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as { code?: string }).code).toBe("tools-unsupported");
    expect(failure?.message).toContain("function calling");
    expect(failure?.details).toContain("does not support tool calls");
    expect(consumeToolsUnsupportedHint()).toBe(true);
    expect(consumeToolsUnsupportedHint()).toBe(false);
  });

  it("passes non-tool rejections through untouched", async () => {
    const toolsBody = JSON.stringify({
      model: "plain-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    globalThis.fetch = (async () =>
      new Response("temperature must be a number", { status: 400 })) as typeof fetch;

    const response = await resilientProviderFetch(
      "https://fc-passthrough.test/v1/chat/completions",
      {
        method: "POST",
        body: toolsBody,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("temperature must be a number");
    expect(consumeToolsUnsupportedHint()).toBe(false);
  });
});

describe("extractReasoningDelta", () => {
  it("reads reasoning_content and reasoning fields", () => {
    expect(extractReasoningDelta({ choices: [{ delta: { reasoning_content: "思考" } }] })).toEqual({
      text: "思考",
      field: "reasoning_content",
    });
    expect(extractReasoningDelta({ choices: [{ delta: { reasoning: "step 1" } }] })).toEqual({
      text: "step 1",
      field: "reasoning",
    });
  });

  it("ignores plain content deltas", () => {
    expect(extractReasoningDelta({ choices: [{ delta: { content: "answer" } }] })).toEqual({
      text: "",
      field: "",
    });
    expect(extractReasoningDelta(null)).toEqual({ text: "", field: "" });
  });

  it("keeps reasoning text out of the answer stream", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"hidden"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"visible"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    const deltas: string[] = [];
    const text = await completeText(config(), "system", "user", {
      onDelta: (delta) => deltas.push(delta),
    });

    expect(text).toBe("visible");
    expect(deltas).toEqual(["visible"]);
  });
});

describe("OpenAI Responses protocol", () => {
  it("posts to /responses with instructions and input", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          output_text: "planned answer",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "planned answer" }],
            },
          ],
          usage: { input_tokens: 40, output_tokens: 6 },
          model: "gpt-5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const text = await completeText(config({ kind: "openai-responses" }), "sys", "user");
    expect(text).toBe("planned answer");
    expect(requests[0]?.url).toBe("https://provider.test/v1/responses");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    const body = requestBody(requests[0]?.init);
    expect(body.model).toBe("test-model");
    expect(body.instructions).toBe("sys");
    expect(body.input).toEqual([{ role: "user", content: "user" }]);
  });

  it("streams output_text deltas and reasoning summaries", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\n',
        'data: {"type":"response.reasoning_summary_text.delta","delta":"pondering"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"hello "}\n\n',
        'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2},"model":"gpt-5"}}\n\n',
      ])) as typeof fetch;

    const deltas: string[] = [];
    const reasoning: string[] = [];
    let usage: ProviderTokenUsage | null = null;
    const text = await completeText(config({ kind: "openai-responses" }), "sys", "user", {
      onDelta: (delta) => deltas.push(delta),
      onReasoning: (delta) => reasoning.push(delta),
      onUsage: (seen) => {
        usage = seen;
      },
    });

    expect(text).toBe("hello world");
    expect(deltas).toEqual(["hello ", "world"]);
    expect(reasoning).toEqual(["pondering"]);
    expect(usage).toEqual({ promptTokens: 5, completionTokens: 2 });
  });

  it("maps an empty Responses payload to a clear error", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "completed", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await expect(completeText(config({ kind: "openai-responses" }), "sys", "user")).rejects.toThrow(
      /no output text/i,
    );
  });
});

describe("Anthropic protocol", () => {
  it("posts to /v1/messages with x-api-key auth and a system field", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "claude reply" }],
          usage: { input_tokens: 30, output_tokens: 4 },
          model: "claude-test",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const text = await completeText(
      config({ kind: "anthropic", baseUrl: "https://api.anthropic.test" }),
      "sys",
      "user",
    );
    expect(text).toBe("claude reply");
    expect(requests[0]?.url).toBe("https://api.anthropic.test/v1/messages");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("x-api-key")).toBe("secret");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("authorization")).toBeNull();
    const body = requestBody(requests[0]?.init);
    expect(body.model).toBe("test-model");
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "user" }]);
    expect(body.temperature).toBe(0.2);
    expect(body).not.toHaveProperty("thinking");
  });

  it("ignores trailing slashes and an existing /v1 suffix when building the URL", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await completeText(
      config({ kind: "anthropic", baseUrl: "https://api.anthropic.test/" }),
      "s",
      "u",
    );
    await completeText(
      config({ kind: "anthropic", baseUrl: "https://api.anthropic.test/v1" }),
      "s",
      "u",
    );
    expect(urls).toEqual([
      "https://api.anthropic.test/v1/messages",
      "https://api.anthropic.test/v1/messages",
    ]);
  });

  it("enables extended thinking for reasoning efforts above auto", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(requestBody(init));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await completeText(config({ kind: "anthropic", reasoningEffort: "high" }), "sys", "user");

    expect(bodies[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 16_384 });
    expect(bodies[0]?.max_tokens).toBe(17_408);
    expect(bodies[0]).not.toHaveProperty("temperature");
  });

  it("streams text and thinking deltas and stop_reason", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":11}}}\n\n',
        'data: {"type":"content_block_start","content_block":{"type":"thinking"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"why"}}\n\n',
        'data: {"type":"content_block_start","content_block":{"type":"text"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" now"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ])) as typeof fetch;

    const deltas: string[] = [];
    const reasoning: string[] = [];
    let usage: ProviderTokenUsage | null = null;
    const text = await completeText(config({ kind: "anthropic" }), "sys", "user", {
      onDelta: (delta) => deltas.push(delta),
      onReasoning: (delta) => reasoning.push(delta),
      onUsage: (seen) => {
        usage = seen;
      },
    });

    expect(text).toBe("answer now");
    expect(deltas).toEqual(["answer", " now"]);
    expect(reasoning).toEqual(["why"]);
    expect(usage).toEqual({ promptTokens: 11, completionTokens: 7 });
  });

  it("adds a JSON instruction to the system prompt instead of response_format", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: '{"ok":true}' }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await completeJson(config({ kind: "anthropic" }), "be terse", "user");
    // The request is asserted indirectly: a bad JSON response would throw,
    // so reaching here means completeJson accepted the payload above.
  });
});

describe("Gemini protocol", () => {
  function geminiResponse(text: string, usage?: Record<string, unknown>): Response {
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
        modelVersion: "gemini-2.5-pro",
        ...usage,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("posts to /v1beta/models/<model>:generateContent with x-goog-api-key", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return geminiResponse("gemini reply");
    }) as typeof fetch;

    const text = await completeText(
      config({ kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com" }),
      "sys",
      "user",
    );
    expect(text).toBe("gemini reply");
    expect(requests[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent",
    );
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("x-goog-api-key")).toBe("secret");
    expect(headers.get("authorization")).toBeNull();
    const body = requestBody(requests[0]?.init);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "user" }] }]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    const generation = body.generationConfig as Record<string, unknown>;
    expect(generation.temperature).toBe(0.2);
    expect(generation.maxOutputTokens).toBe(8000);
    expect(generation).not.toHaveProperty("responseMimeType");
    expect(generation).not.toHaveProperty("thinkingConfig");
  });

  it("encodes the model id into the URL path", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return geminiResponse("ok");
    }) as typeof fetch;

    await completeText(
      config({
        kind: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        model: "gemini-2.5-flash",
      }),
      "s",
      "u",
    );
    await completeText(config({ kind: "gemini", model: "gemini-2.5-pro-preview-05-06" }), "s", "u");
    expect(urls[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(urls[1]).toBe(
      "https://provider.test/v1beta/models/gemini-2.5-pro-preview-05-06:generateContent",
    );
  });

  it("adds responseMimeType for JSON mode and thinkingConfig for reasoning efforts", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(requestBody(init));
      return geminiResponse("{}");
    }) as typeof fetch;

    await completeJson(config({ kind: "gemini", reasoningEffort: "high" }), "sys", "user");

    const generation = bodies[0]?.generationConfig as Record<string, unknown>;
    expect(generation.responseMimeType).toBe("application/json");
    expect(generation.thinkingConfig).toEqual({ thinkingBudget: 24_576 });
  });

  it("drops nested generationConfig fields on HTTP 400", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      const body = requestBody(init);
      bodies.push(body);
      const generation = body.generationConfig as Record<string, unknown>;
      // The endpoint rejects the JSON-mode hint but accepts everything else.
      if (generation.responseMimeType) {
        return new Response("responseMimeType unsupported", {
          status: 400,
          statusText: "Bad Request",
        });
      }
      return geminiResponse("{}");
    }) as typeof fetch;

    await completeJson(config({ kind: "gemini", reasoningEffort: "low" }), "sys", "user");

    expect(bodies).toHaveLength(2);
    const first = bodies[0]?.generationConfig as Record<string, unknown>;
    expect(first.thinkingConfig).toEqual({ thinkingBudget: 1_024 });
    expect(first.responseMimeType).toBe("application/json");
    const second = bodies[1]?.generationConfig as Record<string, unknown>;
    expect(second).not.toHaveProperty("responseMimeType");
    expect(second.thinkingConfig).toEqual({ thinkingBudget: 1_024 });
  });

  it("streams text and thought deltas with usageMetadata", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"secret plan","thought":true}],"role":"model"}}],"modelVersion":"gemini-2.5-pro"}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"final"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":3}}\n\n',
      ])) as typeof fetch;

    const deltas: string[] = [];
    const reasoning: string[] = [];
    let usage: ProviderTokenUsage | null = null;
    const text = await completeText(config({ kind: "gemini" }), "sys", "user", {
      onDelta: (delta) => deltas.push(delta),
      onReasoning: (delta) => reasoning.push(delta),
      onUsage: (seen) => {
        usage = seen;
      },
    });

    expect(text).toBe("final");
    expect(deltas).toEqual(["final"]);
    expect(reasoning).toEqual(["secret plan"]);
    expect(usage).toEqual({ promptTokens: 12, completionTokens: 3 });
  });

  it("marks thought parts as reasoning in the stream", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"think first","thought":true}]},"modelVersion":"gemini-2.5-pro"}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2}}\n\n',
      ])) as typeof fetch;

    const reasoning: string[] = [];
    const text = await completeText(config({ kind: "gemini" }), "sys", "user", {
      onDelta: () => {},
      onReasoning: (delta) => reasoning.push(delta),
    });

    expect(text).toBe("answer");
    expect(reasoning).toEqual(["think first"]);
  });

  it("maps a Gemini error payload to a clear ProviderError", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(completeText(config({ kind: "gemini" }), "sys", "user")).rejects.toThrow(
      /API key not valid/i,
    );
  });

  it("reports an empty Gemini answer clearly", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [] } }], usageMetadata: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(completeText(config({ kind: "gemini" }), "sys", "user")).rejects.toThrow(
      /no text parts/i,
    );
  });
});
