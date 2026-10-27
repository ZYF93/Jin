import type { BundledLanguage } from "shiki";

const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "typescript",
  tsx: "tsx",
  javascript: "javascript",
  jsx: "jsx",
  vue: "vue",
  python: "python",
  java: "java",
  kotlin: "kotlin",
  go: "go",
  rust: "rust",
  css: "css",
  scss: "scss",
  html: "html",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  markdown: "markdown",
  toml: "toml",
  shellscript: "bash",
  sql: "sql",
  xml: "xml",
  text: "text",
};

const cache = new Map<string, string>();
const MAX_CACHE = 24;
const MAX_HIGHLIGHT_CHARS = 160_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainHighlight(code: string): string {
  const lines = code.split("\n");
  const body = lines
    .map((line) => `<span class="line">${escapeHtml(line) || " "}</span>`)
    .join("\n");
  return `<pre class="shiki"><code>${body}</code></pre>`;
}

/**
 * Shiki is loaded lazily by the renderer. The cache is deliberately small:
 * source files can be large, and stale file contents are not worth retaining.
 */
export async function highlightCode(code: string, language: string): Promise<string> {
  if (code.length > MAX_HIGHLIGHT_CHARS) return plainHighlight(code);
  const lang = LANGUAGE_ALIASES[language] ?? "text";
  const key = `${lang}\u0000${code}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  let html: string;
  try {
    const { codeToHtml } = await import("shiki");
    html = await codeToHtml(code, {
      lang: lang as BundledLanguage,
      themes: { dark: "github-dark-default", light: "github-light" },
      defaultColor: false,
    });
  } catch {
    html = plainHighlight(code);
  }

  cache.set(key, html);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return html;
}
