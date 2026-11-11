import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Structured diagnostics log for every LLM exchange. Each entry becomes one
 * JSONL line in `<userData>/logs/llm-YYYY-MM-DD.jsonl` and a compact console
 * line, so provider traffic can be followed live in the dev terminal and
 * inspected after the fact without a debugger.
 *
 * The module is deliberately Electron-free (plain node APIs) so tests can
 * point it at a temporary directory. `logLlm` never throws: diagnostics must
 * not break a model call.
 */

export type LlmLogEvent = "request" | "response" | "error" | "http";

/** Chunk-level counters collected while consuming one streaming response. */
export interface LlmStreamStats {
  /** SSE data events parsed (including usage-only and `[DONE]`). */
  events: number;
  /** Events that carried answer text. */
  deltas: number;
  /** Total answer characters. */
  contentChars: number;
  /** Characters that arrived inside reasoning fields instead of content. */
  reasoningChars: number;
  /** Name of the field that carried the reasoning text, when seen. */
  reasoningField: string;
  /** Events that carried tool_call deltas. */
  toolCallChunks: number;
  /** Last finish_reason seen on the stream. */
  finishReason: string;
  /** Model id echoed by the provider. */
  model: string;
  /** Whether any usage object was received. */
  usageSeen: boolean;
}

export interface LlmLogEntry {
  event: LlmLogEvent;
  /** ISO timestamp; filled automatically when omitted. */
  ts?: string;
  /** Call site label: plan | implement | acceptance | scan | models | eko. */
  phase?: string;
  provider?: string;
  model?: string;
  /** Request URL without query string (keys never appear there or in headers). */
  url?: string;
  method?: string;
  streaming?: boolean;
  /** 1-based HTTP attempt number for retry chains. */
  attempt?: number;
  status?: number;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  messageCount?: number;
  /** Total prompt characters across all messages. */
  requestChars?: number;
  /** Clipped prompt preview. */
  requestPreview?: string;
  responseChars?: number;
  /** Clipped answer preview. */
  responsePreview?: string;
  requestBytes?: number;
  responseBytes?: number;
  /** Optional JSON fields the provider rejected and Jin dropped. */
  droppedFields?: string[];
  stream?: LlmStreamStats;
  error?: string;
  details?: string;
}

const KEEP_DAYS = 14;
const MAX_PREVIEW_CHARS = 6_000;

let logDir: string | null = null;

export function initLlmLog(dir: string): void {
  logDir = dir;
  try {
    mkdirSync(dir, { recursive: true });
    pruneOldLogs(dir);
  } catch {
    // Diagnostics must never prevent startup.
  }
}

export function llmLogDir(): string {
  return logDir ?? "";
}

/** Current log file name; UTC day keeps rotation deterministic. */
export function llmLogFile(date: Date = new Date()): string {
  return `llm-${date.toISOString().slice(0, 10)}.jsonl`;
}

export function currentLlmLogPath(date: Date = new Date()): string {
  return logDir ? join(logDir, llmLogFile(date)) : "";
}

function pruneOldLogs(dir: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (!/^llm-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    const absolute = join(dir, name);
    try {
      if (statSync(absolute).mtimeMs < cutoff) unlinkSync(absolute);
    } catch {
      // Keep pruning best effort.
    }
  }
}

export function logLlm(entry: LlmLogEntry): void {
  const ts = entry.ts ?? new Date().toISOString();
  const record: LlmLogEntry = { ts, ...entry };
  try {
    if (process.env.JIN_QUIET !== "1") console.log(consoleLine(record));
  } catch {
    // Console mirroring is best effort.
  }
  if (!logDir) return;
  try {
    const file = llmLogFile(new Date(ts));
    appendFileSync(join(logDir, file), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // A failing log sink must never break a model call.
  }
}

function clockOf(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toISOString().slice(11, 19);
}

function compactUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

function shortNumber(value: number | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "?";
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function msLabel(value: number | undefined): string {
  return value === undefined
    ? "?"
    : value >= 10_000
      ? `${(value / 1000).toFixed(1)}s`
      : `${Math.round(value)}ms`;
}

function consoleLine(entry: LlmLogEntry): string {
  const clock = clockOf(entry.ts ?? new Date().toISOString());
  const phase = entry.phase ? `[${entry.phase}]` : "";
  const tokens =
    entry.promptTokens !== undefined || entry.completionTokens !== undefined
      ? ` tokens in ${shortNumber(entry.promptTokens)} out ${shortNumber(entry.completionTokens)}`
      : "";
  if (entry.event === "request") {
    return `${clock} ▸ llm${phase} ${entry.provider ?? ""} ${entry.model ?? ""} ${
      entry.streaming ? "stream" : "json"
    } prompt ${shortNumber(entry.requestChars)} chars / ${entry.messageCount ?? 0} msgs`.trim();
  }
  if (entry.event === "response") {
    const stream = entry.stream
      ? ` (stream: ${entry.stream.deltas} deltas/${entry.stream.events} events${
          entry.stream.reasoningChars > 0
            ? `, reasoning ${shortNumber(entry.stream.reasoningChars)} chars`
            : ""
        })`
      : "";
    return `${clock} ✓ llm${phase} ${entry.status ?? ""} ${msLabel(entry.durationMs)}${tokens} answer ${shortNumber(
      entry.responseChars,
    )} chars${stream}`.trim();
  }
  if (entry.event === "error") {
    return `${clock} ✗ llm${phase} ${entry.error ?? "unknown error"}`.trim();
  }
  return `${clock} · ${entry.method ?? "GET"} ${compactUrl(entry.url)} ${
    entry.status ?? "ERR"
  } ${msLabel(entry.durationMs)}${entry.attempt ? ` attempt ${entry.attempt}` : ""}${
    entry.requestBytes ? ` ↑${shortNumber(entry.requestBytes)}B` : ""
  }${entry.responseBytes ? ` ↓${shortNumber(entry.responseBytes)}B` : ""}`.trim();
}

/** Strip anything after `?` and clip; query strings sometimes carry keys. */
export function sanitizeUrl(url: string): string {
  const index = url.indexOf("?");
  const clean = index >= 0 ? url.slice(0, index) : url;
  return clean.slice(0, 300);
}

/** Clip text for previews, marking the cut. */
export function clipPreview(text: string, max = MAX_PREVIEW_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [clipped ${text.length - max} chars]`;
}
