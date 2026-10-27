import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { FileContent, FileNode } from "../../../shared/ipc";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-electron",
  "release",
  "coverage",
  ".turbo",
  ".next",
  ".vite",
  "target",
  "build",
  "out",
]);

const MAX_TREE_ENTRIES = 12_000;
const MAX_FILE_BYTES = 512 * 1024;

export interface TreeOptions {
  ignore?: readonly string[];
  maxEntries?: number;
}

function normalizedRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function shouldIgnore(
  root: string,
  absolute: string,
  name: string,
  options: TreeOptions,
): boolean {
  if (DEFAULT_IGNORES.has(name)) return true;
  const rel = normalizedRelative(root, absolute);
  const ignored = options.ignore ?? [];
  return ignored.some((pattern) => {
    const clean = pattern.replace(/^\/+|\/+$/g, "");
    if (!clean) return false;
    if (clean.endsWith("/")) return rel.startsWith(clean);
    return rel === clean || rel.startsWith(`${clean}/`) || name === clean;
  });
}

function fileNode(
  root: string,
  absolute: string,
  name: string,
  options: TreeOptions,
  counter: { value: number },
): FileNode | null {
  if (counter.value >= (options.maxEntries ?? MAX_TREE_ENTRIES)) {
    return null;
  }
  counter.value += 1;
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink()) {
    // Follow file symlinks for viewing, but never recurse into directory links.
    try {
      const target = statSync(absolute);
      if (target.isDirectory()) return null;
    } catch {
      return null;
    }
  }
  if (stats.isDirectory()) {
    let children: FileNode[] = [];
    try {
      children = readdirSync(absolute, { withFileTypes: true })
        .filter((entry) => !shouldIgnore(root, join(absolute, entry.name), entry.name, options))
        .map((entry) =>
          fileNode(
            root,
            join(absolute, entry.name),
            entry.name,
            options,
            counter,
          ),
        )
        .filter((entry): entry is FileNode => entry !== null)
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });
    } catch {
      children = [];
    }
    return {
      name,
      path: normalizedRelative(root, absolute),
      type: "directory",
      children,
    };
  }
  if (!stats.isFile()) return null;
  return {
    name,
    path: normalizedRelative(root, absolute),
    type: "file",
    size: stats.size,
    extension: extname(name).slice(1).toLowerCase(),
  };
}

/** Build a read-only project tree. Hidden project files are included except caches. */
export function buildFileTree(root: string, options: TreeOptions = {}): FileNode {
  const absolute = resolve(root);
  const name = absolute.split(sep).pop() || absolute;
  return (
    fileNode(absolute, absolute, name, options, { value: 0 }) ?? {
      name,
      path: "",
      type: "directory",
      children: [],
    }
  );
}

function safeProjectPath(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  const rootReal = realpathSync(root);
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  if (absolute !== rootReal && !absolute.startsWith(prefix)) {
    throw new Error("Path escapes the project root");
  }
  if (!existsSync(absolute)) throw new Error(`File does not exist: ${relativePath}`);
  const real = realpathSync(absolute);
  if (real !== rootReal && !real.startsWith(prefix)) {
    throw new Error("Path escapes the project root through a symlink");
  }
  return real;
}

export function languageForFile(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    vue: "vue",
    py: "python",
    java: "java",
    kt: "kotlin",
    kts: "kotlin",
    go: "go",
    rs: "rust",
    css: "css",
    scss: "scss",
    html: "html",
    json: "json",
    jsonc: "jsonc",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    toml: "toml",
    sh: "shellscript",
    sql: "sql",
    xml: "xml",
    svg: "xml",
  };
  return map[ext] ?? "text";
}

/** Read a UTF-8 project file, refusing binary or oversized content. */
export function readProjectFile(
  root: string,
  relativePath: string,
  maxBytes = MAX_FILE_BYTES,
): FileContent {
  const absolute = safeProjectPath(root, relativePath);
  const stats = statSync(absolute);
  if (!stats.isFile()) throw new Error(`Not a file: ${relativePath}`);
  const buffer = readFileSync(absolute);
  if (buffer.includes(0)) throw new Error("Binary files cannot be displayed");
  const truncated = buffer.length > maxBytes;
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
  let content = slice.toString("utf8");
  if (truncated) content += "\n\n// … file truncated by Jin's read-only viewer …";
  return {
    path: normalizedRelative(root, absolute),
    content,
    language: languageForFile(relativePath),
    size: stats.size,
    truncated,
  };
}

/** Return a project-relative path after validating it stays under root. */
export function resolveProjectFile(root: string, relativePath: string): string {
  return safeProjectPath(root, relativePath);
}

export { MAX_FILE_BYTES, MAX_TREE_ENTRIES };
