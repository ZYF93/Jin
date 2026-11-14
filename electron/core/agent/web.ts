import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
]);

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map((part) => Number(part));
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fe80") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd")
    );
  }
  return false;
}

/** Reject URLs that would let the model reach the machine or the local network. */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a full http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed.");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("That host is not allowed.");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("That host is not allowed.");
    return url;
  }
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error("That host resolves to a private address.");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "That host is not allowed.") throw error;
    // DNS failures surface later as a fetch error with the provider's message.
  }
  return url;
}

/** Convert an HTML document to readable text without adding dependencies. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|ul|ol|pre|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface FetchTextOptions {
  maxChars?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** Fetch a public URL and return readable text (HTML is stripped to text). */
export async function fetchPage(
  rawUrl: string,
  options: FetchTextOptions = {},
): Promise<FetchedPage> {
  const url = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; JinBot/1.0; +https://jin.local)",
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES * 2) throw new Error("The page is too large to read.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) throw new Error("The page is too large to read.");
    const raw = buffer.toString("utf8");
    let text = raw;
    let title = "";
    if (contentType.includes("html") || /^\s*</.test(raw)) {
      const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
      title = titleMatch?.[1] ? htmlToText(titleMatch[1]) : "";
      text = htmlToText(raw);
    } else if (contentType.includes("json")) {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        text = raw;
      }
    }
    const maxChars = Math.max(500, Math.min(60_000, options.maxChars ?? DEFAULT_MAX_CHARS));
    const truncated = text.length > maxChars;
    return {
      url: url.toString(),
      title,
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  /** JSON search endpoint. Must be configured in Settings; Jin ships no key. */
  endpoint?: string;
  apiKey?: string | null;
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Query a configured JSON search endpoint (Brave, Tavily, SearXNG, …). The
 * response shape is normalized across the common variants so users can point
 * Jin at whichever provider they already pay for.
 */
export async function searchWeb(query: string, options: SearchOptions): Promise<SearchHit[]> {
  const endpoint = options.endpoint?.trim();
  if (!query.trim()) throw new Error("Search query is required");
  if (!endpoint) {
    throw new Error(
      "No web search endpoint is configured. Open Settings → Provider and set a search endpoint, or use fetch_url with a known URL.",
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("The search endpoint is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The search endpoint must be http(s).");
  }
  const limit = Math.max(1, Math.min(20, options.limit ?? 6));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    // SearXNG style GET; Brave/Tavily style POST with a JSON body.
    const isSearx = endpoint.includes("searx");
    if (isSearx) {
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
    }
    const response = await fetch(url, {
      method: isSearx ? "GET" : "POST",
      headers: { ...headers, ...(isSearx ? {} : { "content-type": "application/json" }) },
      body: isSearx ? undefined : JSON.stringify({ q: query, count: limit, query }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Search failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as unknown;
    return normalizeSearchPayload(payload, limit);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function normalizeSearchPayload(payload: unknown, limit: number): SearchHit[] {
  const record = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(record.results)
    ? record.results
    : Array.isArray(record.organic_results)
      ? record.organic_results
      : Array.isArray(record.web)
        ? ((record.web as { results?: unknown }).results as unknown[])
        : Array.isArray(record.data)
          ? record.data
          : Array.isArray(payload)
            ? payload
            : [];
  const hits: SearchHit[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const url =
      typeof entry.url === "string" ? entry.url : typeof entry.link === "string" ? entry.link : "";
    if (!url) continue;
    hits.push({
      title:
        typeof entry.title === "string"
          ? entry.title
          : typeof entry.name === "string"
            ? entry.name
            : url,
      url,
      snippet:
        typeof entry.snippet === "string"
          ? entry.snippet
          : typeof entry.description === "string"
            ? entry.description
            : typeof entry.content === "string"
              ? entry.content
              : "",
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
