import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  completeJson,
  completeText,
  extractUsage,
  type ProviderConfig,
  type ProviderTokenUsage,
} from "./provider";

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
