import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directories that never contain first-party source worth searching. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".jin",
  ".hg",
  ".svn",
  "dist",
  "dist-electron",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_SCANNED = 20_000;

export interface GrepHit {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface GrepOptions {
  /** Sub-directory to search, relative to the project root. */
  path?: string;
  /** Only include files matching this glob, e.g. `*.ts` or a recursive path glob. */
  glob?: string;
  /** Case-insensitive search. */
  ignoreCase?: boolean;
  limit?: number;
  signal?: AbortSignal;
}

export interface GrepResult {
  hits: GrepHit[];
  filesScanned: number;
  truncated: boolean;
}

/** Convert a simple glob (`*`, `**`, `?`, `{a,b}`) to an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const clean = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (char === "*") {
      if (clean[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (clean[i + 1] === "/") i += 1; // `**/` also matches zero directories
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const end = clean.indexOf("}", i);
      if (end > 0) {
        const parts = clean.slice(i + 1, end).split(",");
        out += `(?:${parts.map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
        i = end;
      } else {
        out += "\\{";
      }
    } else if ("\\^$+.()|[]".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function walkFiles(root: string, options: { path?: string; signal?: AbortSignal }): string[] {
  const start = options.path?.trim() ? join(root, options.path) : root;
  const files: string[] = [];
  const pending: string[] = [start];
  while (pending.length > 0 && files.length < MAX_FILES_SCANNED) {
    if (options.signal?.aborted) break;
    const current = pending.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        pending.push(full);
      } else if (entry.isFile()) {
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
        } catch {
          continue;
        }
        files.push(full);
      }
    }
  }
  return files;
}

function isBinary(buffer: Buffer): boolean {
  const slice = buffer.subarray(0, 8000);
  return slice.includes(0);
}

/**
 * Search source files for a regular expression. Designed as the agent's
 * precise-search tool: no external ripgrep dependency, deterministic ignores,
 * and hard caps so a huge repository cannot stall a turn.
 */
export function grepFiles(root: string, pattern: string, options: GrepOptions = {}): GrepResult {
  const limit = Math.max(1, Math.min(500, options.limit ?? 80));
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, options.ignoreCase ? "i" : "");
  } catch (error) {
    throw new Error(
      `Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const glob = options.glob?.trim() ? globToRegExp(options.glob) : null;
  const files = walkFiles(root, options);
  const hits: GrepHit[] = [];
  let filesScanned = 0;
  let truncated = false;
  for (const file of files) {
    if (options.signal?.aborted) break;
    const rel = relative(root, file).split(sep).join("/");
    if (glob && !glob.test(rel)) continue;
    let content: string;
    try {
      const buffer = readFileSync(file);
      if (isBinary(buffer)) continue;
      content = buffer.toString("utf8");
    } catch {
      continue;
    }
    filesScanned += 1;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!regex.test(line)) continue;
      hits.push({
        path: rel,
        line: index + 1,
        column: line.length - line.trimStart().length + 1,
        text: line.trim().slice(0, 400),
      });
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  return { hits, filesScanned, truncated };
}

export interface GlobResult {
  paths: string[];
  truncated: boolean;
}

/** List project files matching a glob, sorted for stable output. */
export function globFiles(root: string, pattern: string, limit = 200): GlobResult {
  const clean = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean) return { paths: [], truncated: false };
  const regex = globToRegExp(clean);
  const cap = Math.max(1, Math.min(1000, limit));
  const paths = walkFiles(root, {})
    .map((file) => relative(root, file).split(sep).join("/"))
    .filter((path) => regex.test(path))
    .sort();
  return { paths: paths.slice(0, cap), truncated: paths.length > cap };
}
