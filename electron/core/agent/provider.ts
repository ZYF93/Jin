import type { ProviderSettings } from "../../../shared/ipc";

export interface ProviderConfig extends Omit<ProviderSettings, "hasApiKey"> {
  apiKey: string | null;
}

export interface ProviderTokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Best-effort token telemetry from the provider response. */
  onUsage?: (usage: ProviderTokenUsage) => void;
  /**
   * When set, the request uses SSE streaming and receives text deltas as they
   * arrive. The resolved string is still the complete response.
   */
  onDelta?: (delta: string) => void;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Read token usage from OpenAI-compatible and Ollama-style responses. */
export function extractUsage(value: unknown): ProviderTokenUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const usage =
    typeof record.usage === "object" && record.usage !== null
      ? (record.usage as Record<string, unknown>)
      : record;
  const promptTokens = count(
    usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.prompt_eval_count,
  );
  const completionTokens = count(
    usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.eval_count,
  );
  if (promptTokens === 0 && completionTokens === 0) return null;
  return { promptTokens, completionTokens };
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly details?: string,
    readonly status?: number,
    readonly providerName?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function providerFailure(response: Response, body: string): ProviderError {
  const statusLabel = `Provider ${response.status} ${response.statusText}`.trim();
  let providerName = "";
  let providerMessage = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      providerName = typeof record.provider_name === "string" ? record.provider_name.trim() : "";
      const error = record.error;
      if (typeof error === "string") providerMessage = error;
      else if (typeof error === "object" && error !== null) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") providerMessage = message.trim();
      }
    }
  } catch {
    providerMessage = body.trim();
  }

  const source = providerName ? ` at ${providerName}` : "";
  const summary =
    response.status === 429
      ? `Provider rate limit reached${source} (429). Wait briefly and retry, or check the provider limits.`
      : `${statusLabel}${source}${providerMessage ? `: ${providerMessage.slice(0, 320)}` : ""}`;
  const details = [
    statusLabel,
    providerName ? `Provider: ${providerName}` : "",
    providerMessage ? `Message: ${providerMessage}` : "",
    body ? `Raw response:\n${body.slice(0, 4_000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return new ProviderError(
    summary,
    details || undefined,
    response.status,
    providerName || undefined,
  );
}

interface ProviderCircuit {
  failures: number;
  openUntil: number;
  probing: boolean;
}

const providerCircuits = new Map<string, ProviderCircuit>();
const RETRY_DELAYS_MS = [300, 800] as const;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 30_000;

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError("Provider request was cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new ProviderError("Provider request was cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Retry transient endpoint failures and temporarily stop calling a failing provider. */
async function resilientFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  fetchAttempt: () => Promise<Response> = () => fetch(url, init),
): Promise<Response> {
  const circuitKey = url.replace(/\/$/, "").toLowerCase();
  const circuit = providerCircuits.get(circuitKey) ?? {
    failures: 0,
    openUntil: 0,
    probing: false,
  };
  const now = Date.now();
  if (circuit.openUntil > now) {
    const retryAfterSeconds = Math.ceil((circuit.openUntil - now) / 1000);
    throw new ProviderError(
      `Provider circuit is open after repeated failures. Retry in ${retryAfterSeconds} seconds.`,
      undefined,
      undefined,
      undefined,
      retryAfterSeconds,
    );
  }
  if (circuit.openUntil > 0 && circuit.probing) {
    throw new ProviderError(
      "Provider circuit is checking recovery; retry shortly.",
      undefined,
      undefined,
      undefined,
      1,
    );
  }
  const halfOpen = circuit.openUntil > 0;
  if (halfOpen) circuit.probing = true;
  providerCircuits.set(circuitKey, circuit);

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetchAttempt();
      if (response.ok || !isTransientStatus(response.status)) {
        providerCircuits.delete(circuitKey);
        return response;
      }
      lastError = new ProviderError(`Provider returned HTTP ${response.status}`);
      if (attempt === RETRY_DELAYS_MS.length) {
        circuit.failures += 1;
        circuit.probing = false;
        if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD || halfOpen) {
          circuit.openUntil = Date.now() + CIRCUIT_OPEN_MS;
        }
        providerCircuits.set(circuitKey, circuit);
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt === RETRY_DELAYS_MS.length) {
        circuit.failures += 1;
        circuit.probing = false;
        if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD || halfOpen) {
          circuit.openUntil = Date.now() + CIRCUIT_OPEN_MS;
        }
        providerCircuits.set(circuitKey, circuit);
        throw error;
      }
    }
    await waitForRetry(RETRY_DELAYS_MS[attempt], signal);
  }
  throw lastError instanceof Error ? lastError : new ProviderError(String(lastError));
}

/** Resilient fetch adapter for SDKs that perform their own provider calls. */
export const resilientProviderFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : null;
  let url: string;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else url = input.url;
  const requestInit = init ?? {};
  const signal = requestInit.signal ?? request?.signal ?? new AbortController().signal;
  return resilientFetch(url, requestInit, signal, () =>
    fetch(request ? request.clone() : input, init),
  );
};

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function extractContent(value: unknown): string {
  if (typeof value !== "object" || value === null)
    throw new ProviderError("Provider returned an empty response");
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError("Provider response has no choices");
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    throw new ProviderError("Provider response has no message");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" &&
        part !== null &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  throw new ProviderError("Provider response content is not text");
}

/** Text delta from one OpenAI-compatible or Ollama stream chunk. */
export function extractDelta(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const choice = choices[0] as { delta?: unknown; message?: unknown; text?: unknown };
  const message =
    typeof choice.delta === "object" && choice.delta !== null
      ? (choice.delta as { content?: unknown })
      : typeof choice.message === "object" && choice.message !== null
        ? (choice.message as { content?: unknown })
        : null;
  const content = message?.content ?? choice.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" &&
        part !== null &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

/**
 * Consume an SSE response. Handles CRLF, split chunks, `[DONE]`, usage-only
 * trailing chunks, and servers that ignore `stream:true` and return one JSON
 * body instead.
 */
export async function readStream(response: Response, options: CompletionOptions): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const value = (await response.json()) as unknown;
    const usage = extractUsage(value);
    if (usage) options.onUsage?.(usage);
    const text = extractContent(value);
    if (text) options.onDelta?.(text);
    return text;
  }
  if (!response.body) throw new ProviderError("Provider returned an empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // SSE events end with a blank line; tolerate \\r\\n and split chunks.
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        const match = /\r?\n\r?\n/.exec(buffer.slice(boundary));
        buffer = buffer.slice(boundary + (match?.[0].length ?? 2));
        for (const rawLine of event.split(/\r?\n/)) {
          const line = rawLine.startsWith("data:") ? rawLine.slice(5).trim() : "";
          if (!line) continue;
          if (line === "[DONE]") {
            done = true;
            break;
          }
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          const usage = extractUsage(value);
          if (usage) options.onUsage?.(usage);
          const delta = extractDelta(value);
          if (!delta) continue;
          content += delta;
          options.onDelta?.(delta);
        }
        if (done) break;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    // Some servers omit the final blank line; process a residual data line.
    const residual = buffer.trim();
    if (!done && residual.startsWith("data:")) {
      const line = residual.slice(5).trim();
      if (line && line !== "[DONE]") {
        try {
          const value = JSON.parse(line) as unknown;
          const usage = extractUsage(value);
          if (usage) options.onUsage?.(usage);
          const delta = extractDelta(value);
          if (delta) {
            content += delta;
            options.onDelta?.(delta);
          }
        } catch {
          // A partial trailing event is not fatal; the accumulated text stands.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!content) throw new ProviderError("Provider stream returned no text");
  return content;
}

async function request(
  config: ProviderConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: CompletionOptions,
  json: boolean,
): Promise<string> {
  if (config.kind === "none") {
    throw new ProviderError("No AI provider is configured. Open Settings → AI Provider.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    const streaming = Boolean(options.onDelta);
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 8000,
      stream: streaming,
    };
    if (streaming) body.stream_options = { include_usage: true };
    if (json) body.response_format = { type: "json_object" };
    if (config.reasoningEffort && config.reasoningEffort !== "auto") {
      body.reasoning_effort = config.reasoningEffort;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    let response = await resilientFetch(
      endpoint(config.baseUrl),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      },
      signal,
    );
    // Some OpenAI-compatible servers reject response_format or
    // reasoning_effort. Retry once per optional field; the caller still
    // validates JSON, so dropping them is safe.
    const optionalFields = [
      ...(json && body.response_format ? ["response_format"] : []),
      ...(body.reasoning_effort ? ["reasoning_effort"] : []),
      ...(streaming && body.stream_options ? ["stream_options"] : []),
    ];
    for (const field of optionalFields) {
      if (response.ok || response.status !== 400) break;
      await response.text().catch(() => "");
      delete body[field];
      response = await resilientFetch(
        endpoint(config.baseUrl),
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        },
        signal,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw providerFailure(response, text);
    }
    if (streaming) {
      return await readStream(response, options);
    }
    const value = (await response.json()) as unknown;
    const usage = extractUsage(value);
    if (usage && options.onUsage) {
      try {
        options.onUsage(usage);
      } catch {
        // Telemetry must never break the model call.
      }
    }
    return extractContent(value);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("Provider request was cancelled or timed out");
    }
    throw new ProviderError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

export async function completeJson(
  config: ProviderConfig,
  system: string,
  user: string,
  options: CompletionOptions = {},
): Promise<Record<string, unknown>> {
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  const text = await request(config, messages, { ...options, json: true }, true);
  try {
    return parseJsonObject(text);
  } catch (initialError) {
    if (options.signal?.aborted) throw initialError;

    // Some OpenAI-compatible models ignore JSON mode or prepend internal
    // channel/turn labels. Give the same model one chance to repair the exact
    // response. Do not stream the repair into an already-rendered first pass.
    const invalidResponse = text.slice(0, 12_000);
    try {
      const repaired = await request(
        config,
        [
          ...messages,
          { role: "assistant", content: invalidResponse },
          {
            role: "user",
            content:
              "Your previous response was not valid JSON. Return the same answer as exactly one valid JSON object. Do not add a channel label, explanation, Markdown fence, or any text before or after the object. Preserve the original meaning and fields.",
          },
        ],
        { ...options, onDelta: undefined, json: true },
        true,
      );
      return parseJsonObject(repaired);
    } catch (repairError) {
      if (options.signal?.aborted) throw repairError;
      const initialMessage =
        initialError instanceof Error ? initialError.message : String(initialError);
      const repairMessage =
        repairError instanceof Error ? repairError.message : String(repairError);
      throw new ProviderError(
        `Model response was invalid and automatic JSON repair failed: ${repairMessage}`,
        `Initial response error: ${initialMessage}`,
      );
    }
  }
}

export async function completeText(
  config: ProviderConfig,
  system: string,
  user: string,
  options: CompletionOptions = {},
): Promise<string> {
  return request(
    config,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { ...options, json: false },
    false,
  );
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced: string[] = [];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) fenced.push(match[1].trim());
  }

  const parseCandidates = (source: string): string[] => {
    const candidates: string[] = [];
    for (let start = 0; start < source.length; start += 1) {
      if (source[start] !== "{") continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let end = start; end < source.length; end += 1) {
        const char = source[end];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            candidates.push(source.slice(start, end + 1));
            // Skip nested objects so a valid child object cannot accidentally
            // replace the complete response object.
            start = end;
            break;
          }
        }
      }
    }
    return candidates;
  };

  const candidates = [...fenced.flatMap(parseCandidates), ...parseCandidates(trimmed)];
  let parseError: unknown;
  let foundJson = false;
  let result: Record<string, unknown> | undefined;
  // Prefer the last valid object: models sometimes include an example before
  // the actual answer, or add a short channel label around the final object.
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      foundJson = true;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      }
    } catch (error) {
      parseError = error;
    }
  }
  if (!foundJson && candidates.length === 0) {
    throw new ProviderError("Model did not return a JSON object");
  }
  if (result) return result;
  if (foundJson) throw new ProviderError("Model returned JSON that is not an object");
  throw new ProviderError(
    `Could not parse model JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
  );
}
