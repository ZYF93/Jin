import type { ProviderSettings } from "../../../shared/ipc";
import { clipPreview, logLlm, sanitizeUrl, type LlmStreamStats } from "../log/llm-log";

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
  /** Call-site label used by the LLM diagnostics log, e.g. `plan` or `implement`. */
  phase?: string;
  /** Best-effort token telemetry from the provider response. */
  onUsage?: (usage: ProviderTokenUsage) => void;
  /** Reasoning ("thinking") deltas for providers that stream them separately. */
  onReasoning?: (delta: string) => void;
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
    typeof record.usageMetadata === "object" && record.usageMetadata !== null
      ? (record.usageMetadata as Record<string, unknown>)
      : typeof record.usage === "object" && record.usage !== null
        ? (record.usage as Record<string, unknown>)
        : record;
  const promptTokens = count(
    usage.prompt_tokens ??
      usage.promptTokens ??
      usage.promptTokenCount ??
      usage.input_tokens ??
      usage.prompt_eval_count,
  );
  const completionTokens = count(
    usage.completion_tokens ??
      usage.completionTokens ??
      usage.candidatesTokenCount ??
      usage.output_tokens ??
      usage.eval_count,
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
    /** Machine-readable failure class, e.g. `empty-stream`; used for retries. */
    readonly code?: string,
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
    logLlm({
      event: "error",
      url: sanitizeUrl(url),
      error: `circuit open, retry in ${retryAfterSeconds}s`,
    });
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
    const startedAt = Date.now();
    try {
      const response = await fetchAttempt();
      // A deterministic "no function calling" rejection must not be retried or
      // hidden behind SDK wrapping: detect it, tag it, and fail fast.
      if (!response.ok && requestHasTools(init.body)) {
        const text = await response.text().catch(() => "");
        if (isToolCallRejection(text)) {
          markToolsUnsupported();
          providerCircuits.delete(circuitKey);
          logLlm({
            event: "error",
            url: sanitizeUrl(url),
            method: (init.method as string) || "GET",
            attempt: attempt + 1,
            status: response.status,
            durationMs: Date.now() - startedAt,
            error: "provider rejected tool calls (function calling)",
          });
          throw new ProviderError(
            TOOLS_UNSUPPORTED_MESSAGE,
            [
              `Provider ${response.status} ${response.statusText}`.trim(),
              `Model: ${modelFromBody(init.body) ?? "unknown"}`,
              `Raw response:\n${clipPreview(text, 4_000)}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
            response.status,
            undefined,
            undefined,
            "tools-unsupported",
          );
        }
        // Body was consumed for inspection; hand back an equivalent response.
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      logLlm({
        event: "http",
        url: sanitizeUrl(url),
        method: (init.method as string) || "GET",
        attempt: attempt + 1,
        status: response.status,
        durationMs: Date.now() - startedAt,
        requestBytes: bodyByteLength(init.body),
        responseBytes: contentLength(response),
        model: modelFromBody(init.body),
      });
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
      logLlm({
        event: "error",
        url: sanitizeUrl(url),
        method: (init.method as string) || "GET",
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
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

function bodyByteLength(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  return undefined;
}

function contentLength(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (!header) return undefined;
  const value = Number(header);
  return Number.isFinite(value) ? value : undefined;
}

/** Best-effort model id from an OpenAI-compatible request body (for HTTP logs). */
function modelFromBody(body: unknown): string | undefined {
  if (typeof body !== "string" || body.length > 64_000) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    const model = (parsed as { model?: unknown })?.model;
    return typeof model === "string" ? model : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an OpenAI-compatible request body actually carried a `tools` array. */
export function requestHasTools(body: unknown): boolean {
  if (typeof body !== "string" || body.length > 64_000) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    const tools = (parsed as { tools?: unknown })?.tools;
    return Array.isArray(tools) && tools.length > 0;
  } catch {
    return false;
  }
}

const TOOL_TERMS = [
  "tool",
  "tool_use",
  "tool_choice",
  "tools",
  "function",
  "functions",
  "function calling",
];
const REJECTION_TERMS = [
  "not support",
  "no support",
  "unsupported",
  "unavailable",
  "doesn't support",
  "does not support",
  "don't support",
  "cannot",
  "can't",
  "not enabled",
  "not available",
  "not allowed",
  "unable to",
  "disable",
  "only supports",
  "invalid",
  "unknown",
  "unexpected",
  "missing",
];

/**
 * Heuristic detection of "this endpoint/model cannot do function calling"
 * rejections. Terms must co-occur inside one sentence so unrelated error
 * text (invalid api key, rate limit, …) never triggers the hint.
 */
export function isToolCallRejection(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const sentence of lower.split(/[.;\n]/)) {
    if (
      TOOL_TERMS.some((term) => sentence.includes(term)) &&
      REJECTION_TERMS.some((term) => sentence.includes(term))
    ) {
      return true;
    }
  }
  return false;
}

/** Timestamp until which a tool-call rejection was observed (Eko swallows errors). */
let toolsHintUntil = 0;

export function markToolsUnsupported(): void {
  toolsHintUntil = Date.now() + 120_000;
}

/** Read-and-clear: true when a tool-call rejection was observed very recently. */
export function consumeToolsUnsupportedHint(): boolean {
  if (Date.now() >= toolsHintUntil) return false;
  toolsHintUntil = 0;
  return true;
}

const TOOLS_UNSUPPORTED_MESSAGE =
  "The provider rejected tool calls (function calling). The implementation agent requires a tool-capable model.";

/** Wire protocol used to talk to the provider endpoint. */
export type Protocol = "chat" | "responses" | "anthropic" | "gemini";

export function protocolOf(kind: ProviderSettings["kind"]): Protocol {
  if (kind === "openai-responses") return "responses";
  if (kind === "anthropic") return "anthropic";
  if (kind === "gemini") return "gemini";
  return "chat";
}

function protocolEndpoint(protocol: Protocol, config: ProviderConfig, streaming: boolean): string {
  const base = config.baseUrl.replace(/\/+$/, "");
  if (protocol === "anthropic") {
    // Accept both https://api.anthropic.com and https://api.anthropic.com/v1.
    return `${base.replace(/\/v1$/, "")}/v1/messages`;
  }
  if (protocol === "responses") {
    return `${base}/responses`;
  }
  if (protocol === "gemini") {
    // Accept both https://generativelanguage.googleapis.com and .../v1beta.
    const apiRoot = base.replace(/\/v1beta$/, "").replace(/\/v1$/, "");
    const model = encodeURIComponent(config.model);
    return streaming
      ? `${apiRoot}/v1beta/models/${model}:streamGenerateContent?alt=sse`
      : `${apiRoot}/v1beta/models/${model}:generateContent`;
  }
  return `${base}/chat/completions`;
}

function protocolHeaders(
  protocol: Protocol,
  apiKey: string | null,
  customHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!apiKey) return headers;
  if (protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (protocol === "gemini") {
    headers["x-goog-api-key"] = apiKey;
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  // Custom headers win: they are how users adapt Jin to gateways and proxies
  // that need extra auth or routing headers.
  for (const [key, value] of Object.entries(customHeaders ?? {})) {
    if (key.trim() && key.toLowerCase() !== "content-length") {
      headers[key.trim()] = value;
    }
  }
  return headers;
}

/** Reasoning budget for Anthropic extended thinking, per effort level. */
const ANTHROPIC_THINKING_BUDGET: Record<string, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};

const ANTHROPIC_JSON_INSTRUCTION =
  "Respond with exactly one valid JSON object and no text before or after it.";

export interface ImageAttachment {
  /** Data URL, e.g. `data:image/png;base64,...`. */
  dataUrl: string;
  label?: string;
}

export type MessagePart = { text: string } | { image: ImageAttachment };
export type MessageContent = string | MessagePart[];

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: MessageContent;
}

function contentHasImage(content: MessageContent): boolean {
  return Array.isArray(content) && content.some((part) => "image" in part);
}

function contentText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content.map((part) => ("text" in part ? part.text : "")).join("");
}

function anthropicContent(content: MessageContent): unknown {
  if (typeof content === "string") return content;
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if ("text" in part && part.text) blocks.push({ type: "text", text: part.text });
    if ("image" in part) {
      const match = /^data:([a-z0-9.+/_-]+);base64,(.+)$/i.exec(part.image.dataUrl);
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: match?.[1] ?? "image/png",
          data: match?.[2] ?? part.image.dataUrl,
        },
      });
    }
  }
  return blocks.length ? blocks : "";
}

function geminiParts(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ text: content }];
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if ("text" in part && part.text) parts.push({ text: part.text });
    if ("image" in part) {
      const match = /^data:([a-z0-9.+/_-]+);base64,(.+)$/i.exec(part.image.dataUrl);
      parts.push({
        inline_data: {
          mime_type: match?.[1] ?? "image/png",
          data: match?.[2] ?? part.image.dataUrl,
        },
      });
    }
  }
  return parts.length ? parts : [{ text: "" }];
}

function openAiContent(content: MessageContent): unknown {
  if (typeof content === "string") return content;
  if (!contentHasImage(content)) return contentText(content);
  const items: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if ("text" in part && part.text) items.push({ type: "text", text: part.text });
    if ("image" in part) {
      items.push({ type: "image_url", image_url: { url: part.image.dataUrl } });
    }
  }
  return items;
}

function protocolBody(
  protocol: Protocol,
  config: ProviderConfig,
  messages: LlmMessage[],
  options: CompletionOptions,
  json: boolean,
  streaming: boolean,
): Record<string, unknown> {
  const effort =
    config.reasoningEffort && config.reasoningEffort !== "auto"
      ? config.reasoningEffort
      : undefined;
  const temperature = options.temperature ?? 0.2;
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content))
    .join("\n\n");
  const turns = messages.filter((message) => message.role !== "system");

  if (protocol === "anthropic") {
    const budget = effort ? ANTHROPIC_THINKING_BUDGET[effort] : undefined;
    const maxTokens = options.maxTokens ?? 8000;
    // Anthropic requires max_tokens > budget_tokens while thinking is enabled.
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: budget ? Math.max(maxTokens, budget + 1_024) : maxTokens,
      messages: turns.map((message) => ({
        role: message.role,
        content: anthropicContent(message.content),
      })),
    };
    let systemText = system;
    if (json) {
      systemText = `${systemText ? `${systemText}\n\n` : ""}${ANTHROPIC_JSON_INSTRUCTION}`;
    }
    if (systemText) body.system = systemText;
    body.stream = streaming;
    // Extended thinking requires temperature to be unset (defaults to 1).
    if (!budget) body.temperature = temperature;
    if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
    return body;
  }

  if (protocol === "gemini") {
    const generationConfig: Record<string, unknown> = {
      temperature,
      maxOutputTokens: options.maxTokens ?? 8000,
    };
    if (json) generationConfig.responseMimeType = "application/json";
    if (effort) {
      // Gemini 2.5 thinking budget (Flash caps at 24576, Pro at 32768).
      generationConfig.thinkingConfig = {
        thinkingBudget:
          ({ low: 1_024, medium: 8_192, high: 24_576 } as Record<string, number>)[effort] ?? 8_192,
      };
    }
    const body: Record<string, unknown> = {
      contents: turns.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: geminiParts(message.content),
      })),
      generationConfig,
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return body;
  }

  if (protocol === "responses") {
    const body: Record<string, unknown> = {
      model: config.model,
      instructions: system,
      input: turns.map((message) => ({
        role: message.role,
        content: openAiContent(message.content),
      })),
      max_output_tokens: options.maxTokens ?? 8000,
      stream: streaming,
      temperature,
    };
    if (json) body.text = { format: { type: "json_object" } };
    if (effort) body.reasoning = { effort };
    return body;
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map((message) => ({
      role: message.role,
      content: openAiContent(message.content),
    })),
    temperature,
    max_tokens: options.maxTokens ?? 8000,
    stream: streaming,
  };
  if (streaming) body.stream_options = { include_usage: true };
  if (json) body.response_format = { type: "json_object" };
  if (effort) body.reasoning_effort = effort;
  return body;
}

/** Optional fields that some endpoints reject with HTTP 400 and can be dropped. */
function deleteBodyField(body: Record<string, unknown>, field: string): void {
  const dot = field.indexOf(".");
  if (dot < 0) {
    delete body[field];
    return;
  }
  const parent = body[field.slice(0, dot)];
  if (typeof parent === "object" && parent !== null) {
    delete (parent as Record<string, unknown>)[field.slice(dot + 1)];
  }
}

function protocolOptionalFields(
  protocol: Protocol,
  body: Record<string, unknown>,
  json: boolean,
  streaming: boolean,
): string[] {
  if (protocol === "gemini") {
    const generation = (body.generationConfig ?? {}) as Record<string, unknown>;
    return [
      ...(json && generation.responseMimeType ? ["generationConfig.responseMimeType"] : []),
      ...(generation.thinkingConfig ? ["generationConfig.thinkingConfig"] : []),
      ...(generation.temperature !== undefined ? ["generationConfig.temperature"] : []),
    ];
  }
  if (protocol === "responses") {
    return [
      ...(json && body.text ? ["text"] : []),
      ...(body.reasoning ? ["reasoning"] : []),
      ...(body.temperature !== undefined ? ["temperature"] : []),
    ];
  }
  if (protocol === "anthropic") {
    return body.thinking ? ["thinking"] : [];
  }
  return [
    ...(json && body.response_format ? ["response_format"] : []),
    ...(body.reasoning_effort ? ["reasoning_effort"] : []),
    ...(streaming && body.stream_options ? ["stream_options"] : []),
  ];
}

/** Parse one non-streaming protocol response into text, usage and reasoning. */
function parseResponseValue(
  protocol: Protocol,
  value: unknown,
  rawBody?: string,
): { text: string; usage: ProviderTokenUsage | null } {
  if (protocol === "anthropic") {
    const content = (value as { content?: unknown })?.content;
    const text = Array.isArray(content)
      ? content
          .map((block) =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string"
              ? (block as { text: string }).text
              : "",
          )
          .join("")
      : "";
    const usage = extractUsage(value);
    if (!text) {
      throw new ProviderError("Anthropic response has no text content", rawBodyDetail(rawBody));
    }
    return { text, usage };
  }
  if (protocol === "responses") {
    const record = (value ?? {}) as {
      output_text?: unknown;
      output?: unknown;
    };
    let text = typeof record.output_text === "string" ? record.output_text : "";
    if (!text && Array.isArray(record.output)) {
      text = record.output
        .map((item) =>
          typeof item === "object" &&
          item !== null &&
          (item as { type?: unknown }).type === "message"
            ? ((item as { content?: unknown }).content ?? [])
            : [],
        )
        .flat()
        .map((part) =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "output_text" &&
          typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .join("");
    }
    const usage = extractUsage(value);
    if (!text) {
      throw new ProviderError("Responses API returned no output text", rawBodyDetail(rawBody));
    }
    return { text, usage };
  }
  if (protocol === "gemini") {
    const candidate = ((value as { candidates?: unknown })?.candidates as Array<unknown>)?.[0];
    const parts = ((candidate as { content?: { parts?: unknown } })?.content?.parts ??
      []) as Array<{ text?: unknown; thought?: unknown }>;
    let text = "";
    for (const part of parts) {
      if (typeof part.text !== "string" || !part.text || part.thought === true) continue;
      text += part.text;
    }
    const usage = extractUsage(value);
    if (!text) {
      throw new ProviderError("Gemini response has no text parts", rawBodyDetail(rawBody));
    }
    return { text, usage };
  }
  return { text: extractContent(value, rawBody), usage: extractUsage(value) };
}

/** One parsed protocol event: what a single SSE data line contributes. */
interface SseEventInfo {
  delta?: string;
  reasoning?: { text: string; field: string };
  usage?: ProviderTokenUsage | null;
  finishReason?: string;
  model?: string;
  toolCall?: boolean;
  done?: boolean;
}

const EMPTY_EVENT: SseEventInfo = {};

function responsesUsage(value: unknown): ProviderTokenUsage | null {
  const usage = (value as { response?: { usage?: unknown } })?.response?.usage;
  if (!usage) return null;
  return extractUsage(usage);
}

function parseSseEvent(protocol: Protocol, value: unknown): SseEventInfo {
  if (protocol === "responses") {
    const type = (value as { type?: unknown })?.type;
    if (typeof type !== "string") return EMPTY_EVENT;
    if (type === "response.output_text.delta") {
      const delta = (value as { delta?: unknown }).delta;
      return typeof delta === "string" && delta ? { delta } : EMPTY_EVENT;
    }
    if (type === "response.reasoning_summary_text.delta") {
      const delta = (value as { delta?: unknown }).delta;
      return typeof delta === "string" && delta
        ? { reasoning: { text: delta, field: "reasoning_summary" } }
        : EMPTY_EVENT;
    }
    if (type === "response.output_item.added") {
      const item = (value as { item?: unknown }).item;
      return (item as { type?: unknown })?.type === "function_call"
        ? { toolCall: true }
        : EMPTY_EVENT;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const response = (value as { response?: Record<string, unknown> }).response ?? {};
      return {
        usage: responsesUsage(value),
        finishReason: type === "response.completed" ? "completed" : "incomplete",
        model: typeof response.model === "string" ? response.model : undefined,
      };
    }
    if (type === "response.failed") {
      return { finishReason: "failed" };
    }
    return EMPTY_EVENT;
  }
  if (protocol === "anthropic") {
    const type = (value as { type?: unknown })?.type;
    if (type === "message_start") {
      const message = (value as { message?: Record<string, unknown> }).message ?? {};
      return {
        usage: extractUsage(message.usage),
        model: typeof message.model === "string" ? message.model : undefined,
      };
    }
    if (type === "content_block_start") {
      const block = (value as { content_block?: unknown }).content_block;
      return (block as { type?: unknown })?.type === "tool_use" ? { toolCall: true } : EMPTY_EVENT;
    }
    if (type === "content_block_delta") {
      const delta = (value as { delta?: Record<string, unknown> }).delta ?? {};
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        return { delta: delta.text };
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
        return { reasoning: { text: delta.thinking, field: "thinking" } };
      }
      return EMPTY_EVENT;
    }
    if (type === "message_delta") {
      const info = (value as { delta?: Record<string, unknown>; usage?: unknown }) ?? {};
      return {
        usage: extractUsage(info.usage),
        finishReason:
          typeof info.delta?.stop_reason === "string" ? info.delta.stop_reason : undefined,
      };
    }
    if (type === "message_stop") return { done: true };
    return EMPTY_EVENT;
  }
  if (protocol === "gemini") {
    const candidate = ((value as { candidates?: unknown })?.candidates as Array<unknown>)?.[0];
    const parts = ((candidate as { content?: { parts?: unknown } })?.content?.parts ??
      []) as Array<{ text?: unknown; thought?: unknown }>;
    let delta = "";
    let reasoningText = "";
    for (const part of parts) {
      if (typeof part.text !== "string" || !part.text) continue;
      if (part.thought === true) reasoningText += part.text;
      else delta += part.text;
    }
    const finish = (candidate as { finishReason?: unknown })?.finishReason;
    return {
      ...(delta ? { delta } : {}),
      ...(reasoningText ? { reasoning: { text: reasoningText, field: "thought" } } : {}),
      ...(typeof finish === "string" && finish ? { finishReason: finish } : {}),
      usage: extractUsage(value),
      model:
        typeof (value as { modelVersion?: unknown }).modelVersion === "string"
          ? (value as { modelVersion: string }).modelVersion || undefined
          : undefined,
    };
  }
  const usage = extractUsage(value);
  return {
    ...(usage ? { usage } : {}),
    delta: extractDelta(value),
    reasoning: extractReasoningDelta(value),
    finishReason: finishReasonOf(value) || undefined,
    model:
      typeof (value as { model?: unknown }).model === "string"
        ? (value as { model: string }).model || undefined
        : undefined,
    toolCall: hasToolCallDelta(value),
  };
}

function extractContent(value: unknown, rawBody?: string): string {
  if (typeof value !== "object" || value === null)
    throw new ProviderError("Provider returned an empty response");
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError("Provider response has no choices", rawBodyDetail(rawBody));
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    throw new ProviderError("Provider response has no message", rawBodyDetail(rawBody));
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
  throw new ProviderError("Provider response content is not text", rawBodyDetail(rawBody));
}

/** Raw JSON body clip attached to empty/invalid response diagnostics. */
function rawBodyDetail(rawBody?: string): string | undefined {
  return rawBody ? `Raw response:\n${clipPreview(rawBody, 4_000)}` : undefined;
}

/** Error for a non-streaming response whose message content was empty. */
function emptyBodyError(usageSeen: boolean, rawBody: string, phase: string): ProviderError {
  const stats: LlmStreamStats = {
    ...emptyStreamStats(),
    usageSeen,
    contentChars: 0,
  };
  const details = emptyStreamDetails(
    { stats, lastEvent: clipPreview(rawBody, 2_000) },
    "response mode: single JSON body",
  );
  logLlm({
    event: "error",
    phase,
    error: "Provider response contained no text",
    details,
    stream: stats,
  });
  return new ProviderError(
    "Provider response contained no text",
    details,
    undefined,
    undefined,
    undefined,
    "empty-stream",
  );
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
 * Reasoning text ("thinking") that reasoning models stream alongside or
 * instead of the answer. Jin never treats it as the response, but the
 * diagnostics use it to explain empty streams.
 */
export function extractReasoningDelta(value: unknown): { text: string; field: string } {
  if (typeof value !== "object" || value === null) return { text: "", field: "" };
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { text: "", field: "" };
  const choice = choices[0] as { delta?: unknown; message?: unknown };
  const carriers: Array<[string, unknown]> =
    typeof choice.delta === "object" && choice.delta !== null
      ? Object.entries(choice.delta as Record<string, unknown>)
      : typeof choice.message === "object" && choice.message !== null
        ? Object.entries(choice.message as Record<string, unknown>)
        : [];
  for (const [field, fieldValue] of carriers) {
    if (field !== "reasoning_content" && field !== "reasoning" && field !== "thinking") continue;
    if (typeof fieldValue === "string" && fieldValue) return { text: fieldValue, field };
    if (Array.isArray(fieldValue)) {
      const text = fieldValue
        .map((part) =>
          typeof part === "object" &&
          part !== null &&
          typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .join("");
      if (text) return { text, field };
    }
  }
  return { text: "", field: "" };
}

/** Mutable stream counters filled by `readStream` for logging and errors. */
export interface StreamDiagnostics {
  stats: LlmStreamStats;
  /** Raw JSON of the last parsed SSE event, for post-mortem details. */
  lastEvent: string;
}

function emptyStreamStats(): LlmStreamStats {
  return {
    events: 0,
    deltas: 0,
    contentChars: 0,
    reasoningChars: 0,
    reasoningField: "",
    toolCallChunks: 0,
    finishReason: "",
    model: "",
    usageSeen: false,
  };
}

/** Verbose explanation attached to the "no text" failure. */
function emptyStreamDetails(
  diagnostics: StreamDiagnostics,
  mode = "response mode: streaming (text/event-stream)",
): string {
  const { stats, lastEvent } = diagnostics;
  const lines = [
    "Stream diagnostics:",
    `  ${mode}`,
    `  SSE events: ${stats.events}, content deltas: ${stats.deltas}, content chars: ${stats.contentChars}`,
    stats.reasoningChars > 0
      ? `  reasoning text: ${stats.reasoningChars} chars (field: ${stats.reasoningField || "unknown"})`
      : "  reasoning text: none",
    `  finish_reason: ${stats.finishReason || "(never sent)"}`,
    `  model: ${stats.model || "(unknown)"}`,
    `  tool_call deltas: ${stats.toolCallChunks}`,
    `  usage received: ${stats.usageSeen ? "yes" : "no"}`,
  ];
  if (lastEvent) lines.push("Last event:", clipPreview(lastEvent, 2_000));
  lines.push(
    "Likely causes:",
    "- A reasoning model spent the whole max_tokens budget thinking and produced no final content. Raise max_tokens or disable thinking for this model.",
    "- The provider streamed the answer inside reasoning_content/reasoning instead of content; this endpoint/model combination is not OpenAI-compatible.",
    "- finish_reason=content_filter: the provider withheld the answer.",
    "- The provider sent an empty or heartbeat-only stream; Jin retries once automatically.",
  );
  return lines.join("\n");
}

/**
 * Consume an SSE response. Handles CRLF, split chunks, `[DONE]`, usage-only
 * trailing chunks, and servers that ignore `stream:true` and return one JSON
 * body instead. When `diagnostics` is given it is filled with chunk-level
 * counters for logging and error reporting.
 */
export /** Merge split usage events (e.g. Anthropic input in message_start, output in message_delta). */
function mergeUsage(
  previous: ProviderTokenUsage | null,
  next: ProviderTokenUsage | null,
): ProviderTokenUsage | null {
  if (!next) return previous;
  if (!previous) return next;
  return {
    promptTokens: next.promptTokens || previous.promptTokens,
    completionTokens: next.completionTokens || previous.completionTokens,
  };
}

async function readStream(
  response: Response,
  options: CompletionOptions,
  diagnostics?: StreamDiagnostics,
  protocol: Protocol = "chat",
): Promise<string> {
  const stats = diagnostics?.stats ?? emptyStreamStats();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const rawBody = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(rawBody) as unknown;
    } catch {
      throw new ProviderError(
        "Provider returned invalid JSON instead of a stream",
        `Raw response:\n${clipPreview(rawBody, 4_000)}`,
      );
    }
    const parsed = parseResponseValue(protocol, value, rawBody);
    if (parsed.usage) options.onUsage?.(parsed.usage);
    const text = parsed.text;
    if (!text) {
      const details = emptyStreamDetails(
        { stats, lastEvent: clipPreview(rawBody, 2_000) },
        `response mode: single JSON body (content-type: ${contentType || "unknown"})`,
      );
      logLlm({
        event: "error",
        phase: options.phase,
        error: "Provider response contained no text",
        details,
        stream: stats,
      });
      throw new ProviderError(
        "Provider response contained no text",
        details,
        undefined,
        undefined,
        undefined,
        "empty-stream",
      );
    }
    options.onDelta?.(text);
    return text;
  }
  if (!response.body) throw new ProviderError("Provider returned an empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let done = false;
  let mergedUsage: ProviderTokenUsage | null = null;
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
          stats.events += 1;
          if (diagnostics) diagnostics.lastEvent = clipPreview(line, 2_000);
          const info = parseSseEvent(protocol, value);
          if (info.usage) {
            stats.usageSeen = true;
            mergedUsage = mergeUsage(mergedUsage, info.usage);
            if (mergedUsage) options.onUsage?.(mergedUsage);
          }
          if (info.model) stats.model = info.model;
          if (info.finishReason) stats.finishReason = info.finishReason;
          if (info.toolCall) stats.toolCallChunks += 1;
          if (info.reasoning?.text) {
            stats.reasoningChars += info.reasoning.text.length;
            stats.reasoningField = stats.reasoningField || info.reasoning.field;
            options.onReasoning?.(info.reasoning.text);
          }
          if (info.done) done = true;
          const delta = info.delta;
          if (!delta) continue;
          stats.deltas += 1;
          stats.contentChars += delta.length;
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
          stats.events += 1;
          if (diagnostics) diagnostics.lastEvent = clipPreview(line, 2_000);
          const info = parseSseEvent(protocol, value);
          if (info.usage) {
            stats.usageSeen = true;
            mergedUsage = mergeUsage(mergedUsage, info.usage);
            if (mergedUsage) options.onUsage?.(mergedUsage);
          }
          if (info.done) done = true;
          if (info.delta) {
            stats.deltas += 1;
            stats.contentChars += info.delta.length;
            content += info.delta;
            options.onDelta?.(info.delta);
          }
        } catch {
          // A partial trailing event is not fatal; the accumulated text stands.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!content) {
    logLlm({
      event: "error",
      phase: options.phase,
      streaming: true,
      error: "Provider stream returned no text",
      details: emptyStreamDetails({ stats, lastEvent: diagnostics?.lastEvent ?? "" }),
      stream: stats,
    });
    throw new ProviderError(
      "Provider stream returned no text",
      emptyStreamDetails({ stats, lastEvent: diagnostics?.lastEvent ?? "" }),
      undefined,
      undefined,
      undefined,
      "empty-stream",
    );
  }
  return content;
}

function finishReasonOf(value: unknown): string {
  const choices = (value as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const finish = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof finish === "string" ? finish : "";
}

function hasToolCallDelta(value: unknown): boolean {
  const choices = (value as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return false;
  const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

/** One prompt preview line per message, clipped, for the diagnostics log. */
function previewMessages(messages: LlmMessage[]): string {
  const LIMITS: Record<string, number> = { system: 600, assistant: 1_200, user: 1_500 };
  return messages
    .map(
      (message) =>
        `${message.role}: ${clipPreview(
          contentText(message.content),
          LIMITS[message.role] ?? 800,
        )}`,
    )
    .join("\n\n")
    .slice(0, 4_000);
}

async function request(
  config: ProviderConfig,
  messages: LlmMessage[],
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
  const phase = options.phase ?? "llm";
  const startedAt = Date.now();
  const streaming = Boolean(options.onDelta);
  const requestChars = messages.reduce((total, message) => total + message.content.length, 0);
  const protocol = protocolOf(config.kind);
  const url = protocolEndpoint(protocol, config, streaming);
  const callBase = {
    phase,
    provider: config.kind,
    model: config.model,
    url: sanitizeUrl(url),
  };
  // Capture telemetry for the log without disturbing the caller's callbacks:
  // usage is forwarded to the caller exactly once, after a successful call,
  // so retried attempts never double-count tokens.
  let lastUsage: ProviderTokenUsage | null = null;
  const loggedOptions: CompletionOptions = {
    ...options,
    onUsage: (usage) => {
      lastUsage = usage;
    },
  };
  const forwardUsage = (): void => {
    if (!lastUsage || !options.onUsage) return;
    try {
      options.onUsage(lastUsage);
    } catch {
      // Telemetry must never break the model call.
    }
  };
  // Read through a closure: TypeScript does not track assignments made inside
  // callbacks, so a direct read would be wrongly narrowed to `null`.
  const usageOf = (): ProviderTokenUsage | null => lastUsage;
  logLlm({
    event: "request",
    ...callBase,
    streaming,
    messageCount: messages.length,
    requestChars,
    requestPreview: previewMessages(messages),
  });
  let droppedFields: string[] = [];
  try {
    const body = protocolBody(protocol, config, messages, options, json, streaming);
    const headers: Record<string, string> = protocolHeaders(
      protocol,
      config.apiKey,
      config.customHeaders,
    );
    const fetchBody = (): RequestInit => ({
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    let response = await resilientFetch(url, fetchBody(), signal);
    // Some endpoints reject optional fields (response_format, reasoning,
    // temperature, thinking). Retry once per field; the caller still validates
    // JSON, so dropping them is safe.
    const optionalFields = protocolOptionalFields(protocol, body, json, streaming);
    for (const field of optionalFields) {
      if (response.ok || response.status !== 400) break;
      await response.text().catch(() => "");
      deleteBodyField(body, field);
      droppedFields = [...droppedFields, field];
      logLlm({ event: "http", ...callBase, status: 400, error: `retrying without ${field}` });
      response = await resilientFetch(url, fetchBody(), signal);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw providerFailure(response, text);
    }
    if (streaming) {
      const diagnostics: StreamDiagnostics = { stats: emptyStreamStats(), lastEvent: "" };
      const text = await streamWithEmptyRetry(
        response,
        loggedOptions,
        callBase,
        () => resilientFetch(url, fetchBody(), signal),
        diagnostics,
        protocol,
      );
      forwardUsage();
      logLlm({
        event: "response",
        ...callBase,
        status: response.status,
        durationMs: Date.now() - startedAt,
        promptTokens: usageOf()?.promptTokens,
        completionTokens: usageOf()?.completionTokens,
        responseChars: text.length,
        responsePreview: clipPreview(text),
        droppedFields: droppedFields.length ? droppedFields : undefined,
        stream: diagnostics.stats,
      });
      return text;
    }
    const refetchJson = (): Promise<Response> => resilientFetch(url, fetchBody(), signal);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptResponse = attempt === 1 ? response : await refetchJson();
      const rawBody = await attemptResponse.text();
      let value: unknown;
      try {
        value = JSON.parse(rawBody) as unknown;
      } catch {
        throw new ProviderError(
          "Provider returned invalid JSON",
          `Raw response:\n${clipPreview(rawBody, 4_000)}`,
        );
      }
      const parsed = parseResponseValue(protocol, value, rawBody);
      if (parsed.usage) lastUsage = parsed.usage;
      const text = parsed.text;
      if (text) {
        forwardUsage();
        logLlm({
          event: "response",
          ...callBase,
          status: attemptResponse.status,
          durationMs: Date.now() - startedAt,
          promptTokens: usageOf()?.promptTokens,
          completionTokens: usageOf()?.completionTokens,
          responseChars: text.length,
          responsePreview: clipPreview(text),
          droppedFields: droppedFields.length ? droppedFields : undefined,
        });
        return text;
      }
      if (attempt === 2 || signal.aborted) {
        throw emptyBodyError(Boolean(parsed.usage), rawBody, phase);
      }
      logLlm({
        event: "http",
        ...callBase,
        status: attemptResponse.status,
        attempt: 2,
        error: "empty response body, retrying once",
      });
    }
    throw new ProviderError("Provider response contained no text");
  } catch (error) {
    if (!(error instanceof ProviderError) || error.code !== "empty-stream") {
      // The empty-stream error is already logged inside readStream.
      logLlm({
        event: "error",
        ...callBase,
        streaming,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        details:
          error instanceof ProviderError ? clipPreview(error.details ?? "", 4_000) : undefined,
      });
    }
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("Provider request was cancelled or timed out");
    }
    throw new ProviderError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run one streaming request; when the provider ends the stream without any
 * content (a transient failure some servers emit under load), refetch once.
 * A retry only happens when no delta reached the UI yet, so the visible
 * stream is never rewound or duplicated. The final attempt's diagnostics are
 * copied into `sink` for the response log entry.
 */
async function streamWithEmptyRetry(
  response: Response,
  options: CompletionOptions,
  callBase: { phase?: string; provider?: string; model?: string; url?: string },
  refetch: () => Promise<Response>,
  sink?: StreamDiagnostics,
  protocol: Protocol = "chat",
): Promise<string> {
  let forwarded = false;
  const watched: CompletionOptions = options.onDelta
    ? {
        ...options,
        onDelta: (delta) => {
          forwarded = true;
          options.onDelta?.(delta);
        },
      }
    : options;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptResponse = attempt === 1 ? response : await refetch();
    const attemptDiagnostics: StreamDiagnostics = { stats: emptyStreamStats(), lastEvent: "" };
    try {
      const text = await readStream(
        attemptResponse,
        { ...watched, phase: options.phase },
        attemptDiagnostics,
        protocol,
      );
      if (sink) Object.assign(sink, attemptDiagnostics);
      return text;
    } catch (error) {
      if (
        attempt === 2 ||
        forwarded ||
        !(error instanceof ProviderError) ||
        error.code !== "empty-stream" ||
        options.signal?.aborted
      ) {
        if (sink) Object.assign(sink, attemptDiagnostics);
        throw error;
      }
      // First empty stream with nothing shown yet: transparently refetch.
      if (sink) Object.assign(sink, attemptDiagnostics);
      logLlm({
        event: "http",
        ...callBase,
        streaming: true,
        attempt: 2,
        error: "empty stream, retrying once",
        stream: attemptDiagnostics.stats,
      });
      forwarded = false;
    }
  }
  throw new ProviderError("Provider stream returned no text");
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
  userImages: readonly ImageAttachment[] = [],
): Promise<string> {
  const userContent: MessageContent =
    userImages.length > 0
      ? [...(user ? [{ text: user }] : []), ...userImages.map((image) => ({ image }))]
      : user;
  return request(
    config,
    [
      { role: "system", content: system },
      { role: "user", content: userContent },
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
