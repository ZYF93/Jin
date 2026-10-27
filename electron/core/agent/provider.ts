import type { ProviderSettings } from "../../../shared/ipc";

export interface ProviderConfig extends Omit<ProviderSettings, "hasApiKey"> {
  apiKey: string | null;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function extractContent(value: unknown): string {
  if (typeof value !== "object" || value === null) throw new ProviderError("Provider returned an empty response");
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
        typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  throw new ProviderError("Provider response content is not text");
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
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 8000,
      stream: false,
    };
    if (json) body.response_format = { type: "json_object" };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    let response = await fetch(endpoint(config.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    // Some OpenAI-compatible servers reject response_format. Retry once without
    // it; the caller still validates the JSON, so this is safe.
    if (!response.ok && json && response.status === 400) {
      delete body.response_format;
      response = await fetch(endpoint(config.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `Provider ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`,
      );
    }
    const value = (await response.json()) as unknown;
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
  const text = await request(
    config,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { ...options, json: true },
    true,
  );
  return parseJsonObject(text);
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
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new ProviderError("Model did not return a JSON object");
  }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ProviderError("Model returned JSON that is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      `Could not parse model JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
