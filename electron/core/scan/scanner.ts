import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { ArchEdgeDraft, ArchNodeDraft, L1Kind, NodeKind } from "../../../shared/ledger/types";
import { stableIds } from "../ids/stable";
import type { JinConfig } from "../project/config";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".go",
]);

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
  ".jin",
]);

const MAX_FILES = 5000;
const MAX_BYTES = 512 * 1024;

export interface ScanMember {
  name: string;
  kind: "method" | "field" | "property";
  line?: number;
  character?: number;
}

/** Parsed facts cached by file mtime + size; LSP members are merged every scan. */
export interface ScanManifestEntry {
  parserVersion: number;
  mtimeMs: number;
  size: number;
  language: string;
  lines: number;
  imports: string[];
  exports: string[];
  members: ScanMember[];
  kind: L1Kind;
  title: string;
  responsibility: string;
}

export type ScanManifest = Record<string, ScanManifestEntry>;

export interface ScannedFile {
  path: string;
  absolute: string;
  language: string;
  lines: number;
  symbolLocations: Record<string, { line: number; character?: number }>;
  bytes: number;
  imports: string[];
  exports: string[];
  members: ScanMember[];
  kind: L1Kind;
  title: string;
  responsibility: string;
}

export interface ScanStats {
  files: number;
  symbols: number;
  imports: number;
  nodes: number;
  edges: number;
  languages: Record<string, number>;
}

export interface ScanResult {
  files: ScannedFile[];
  nodes: ArchNodeDraft[];
  edges: ArchEdgeDraft[];
  warnings: string[];
  stats: ScanStats;
  scannedAt: string;
  manifest: ScanManifest;
}

export interface ScanOptions {
  maxFiles?: number;
  signal?: AbortSignal;
  /** Parsed facts from the previous scan, reused when mtime and size match. */
  manifest?: ScanManifest;
  /** Optional LSP document symbols merged into the structural parser output. */
  lspFacts?: ReadonlyMap<
    string,
    ReadonlyArray<{
      name: string;
      kind: ScanMember["kind"];
      line?: number;
      character?: number;
    }>
  >;
}

const SCANNER_PARSER_VERSION = 2;

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function relativePath(root: string, absolute: string): string {
  return toPosix(relative(root, absolute));
}

function ignored(root: string, absolute: string, name: string, config: JinConfig): boolean {
  if (DEFAULT_IGNORES.has(name)) return true;
  const rel = relativePath(root, absolute);
  return config.scan.ignore.some((pattern) => {
    const clean = pattern.replace(/^\/+|\/+$/g, "");
    if (!clean) return false;
    return rel === clean || rel.startsWith(`${clean}/`) || name === clean;
  });
}

function collectFiles(
  root: string,
  config: JinConfig,
  options: ScanOptions,
): { files: string[]; warnings: string[] } {
  const files: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const maxFiles = options.maxFiles ?? MAX_FILES;

  const walk = (absolute: string): void => {
    if (options.signal?.aborted) throw new Error("Scan cancelled");
    if (files.length >= maxFiles) return;
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      if (absolute !== root && ignored(root, absolute, basename(absolute), config)) return;
      let entries;
      try {
        entries = readdirSync(absolute, { withFileTypes: true });
      } catch {
        warnings.push(`Could not read directory ${relativePath(root, absolute) || "."}`);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= maxFiles) {
          warnings.push(`File limit ${maxFiles} reached; scan is incomplete.`);
          return;
        }
        if (entry.isSymbolicLink()) continue;
        const child = join(absolute, entry.name);
        if (entry.isDirectory()) {
          walk(child);
        } else if (
          entry.isFile() &&
          isSourceFile(child) &&
          !ignored(root, child, entry.name, config)
        ) {
          if (seen.has(child)) continue;
          seen.add(child);
          files.push(child);
        }
      }
      return;
    }
    if (
      stats.isFile() &&
      isSourceFile(absolute) &&
      !ignored(root, absolute, basename(absolute), config)
    ) {
      if (!seen.has(absolute)) {
        seen.add(absolute);
        files.push(absolute);
      }
    }
  };

  for (const scanRoot of config.scan.roots) {
    const absolute = resolve(root, scanRoot);
    if (!existsSync(absolute)) {
      warnings.push(`Scan root does not exist: ${scanRoot}`);
      continue;
    }
    walk(absolute);
  }
  return { files, warnings };
}

function stripComments(text: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;
  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (quote) {
      out += char;
      if (char === "\\" && index + 1 < text.length) {
        out += next;
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function matchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length - 1;
}

function classMembers(text: string): ScanMember[] {
  const members: ScanMember[] = [];
  const seen = new Set<string>();
  const classRe = /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*[^{]*\{/g;
  for (const match of text.matchAll(classRe)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingBrace(text, open);
    const body = text.slice(open + 1, close);
    const methodRe =
      /^\s*(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/gm;
    const fieldRe =
      /^\s*(?:(?:public|private|protected|static|readonly|declare)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*:/gm;
    const reserved = new Set([
      "if",
      "for",
      "while",
      "switch",
      "catch",
      "return",
      "new",
      "super",
      "this",
      "constructor",
    ]);
    for (const method of body.matchAll(methodRe)) {
      const name = method[1];
      if (!name || reserved.has(name)) continue;
      const key = `method:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      members.push({ name, kind: "method" });
    }
    for (const field of body.matchAll(fieldRe)) {
      const name = field[1];
      if (!name || reserved.has(name)) continue;
      const key = `property:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      members.push({ name, kind: "property" });
    }
  }
  return members;
}

function topLevelMembers(text: string): ScanMember[] {
  const members: ScanMember[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: ScanMember["kind"]): void => {
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    members.push({ name, kind });
  };
  for (const match of text.matchAll(
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    if (match[1]) add(match[1], "method");
  }
  for (const match of text.matchAll(
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
  )) {
    if (match[1]) add(match[1], "field");
  }
  return members;
}

function firstDocComment(text: string): string {
  const match = text.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match?.[1]) return "";
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 260);
}

function classifyKind(path: string, exports: readonly string[], source: string): L1Kind {
  const lower = path.toLowerCase();
  const code = stripComments(source);
  if (lower.endsWith(".vue") || lower.endsWith(".tsx") || lower.endsWith(".jsx")) {
    return "component";
  }
  if (/\/hooks?\//.test(lower) || exports.some((name) => name.startsWith("use"))) {
    return "hook";
  }
  if (/\/stores?\//.test(lower)) return "store";
  if (/\/routes?\//.test(lower) || /\/pages?\//.test(lower)) return "route";
  if (/\/repositor(y|ies)\//.test(lower)) return "repository";
  if (/\/services?\//.test(lower)) return "service";
  if (/\/entities?\//.test(lower) || /\/models?\//.test(lower)) return "entity";
  if (/\/types?\//.test(lower) || lower.endsWith(".d.ts")) return "type";
  if (/\/config\//.test(lower) || /config\.(ts|js)$/.test(lower)) return "config";
  if (/^\s*export\s+(?:interface|type|enum)\s+/m.test(code)) return "type";
  const functionFile =
    /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(lower) &&
    /^(?:export\s+(?:default\s+)?(?:async\s+)?function\s+|function\s+|export\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/m.test(
      code,
    );
  const pythonFunctionFile = lower.endsWith(".py") && /^(?:async\s+)?def\s+/m.test(code);
  const goFunctionFile = lower.endsWith(".go") && /^func\s+[A-Za-z_]\w*\s*\(/m.test(code);
  const kotlinFunctionFile = /\.kts?$/.test(lower) && /^fun\s+/m.test(code);
  if (functionFile || pythonFunctionFile || goFunctionFile || kotlinFunctionFile) {
    return "function";
  }
  if (
    /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(lower) &&
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+/m.test(code)
  ) {
    return "entity";
  }
  if (
    /\.(?:java|kt|kts)$/.test(lower) &&
    /^\s*(?:(?:public|abstract|data|sealed|open)\s+)*class\s+/m.test(code)
  ) {
    return "entity";
  }
  if (lower.endsWith(".py") && /^class\s+[A-Za-z_]\w*/m.test(code)) return "entity";
  if (lower.endsWith(".go") && /^type\s+[A-Za-z_]\w*\s+struct\b/m.test(code)) return "entity";
  return "module";
}

function parseTypeScript(text: string): {
  imports: string[];
  exports: string[];
  members: ScanMember[];
} {
  const code = stripComments(text);
  const imports = unique(
    [...code.matchAll(/^\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm)]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value))
      .concat(
        [...code.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g)]
          .map((match) => match[1])
          .filter((value): value is string => Boolean(value)),
      ),
  );
  const exports = unique(
    [
      ...code.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm),
      ...code.matchAll(/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm),
      ...code.matchAll(/^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm),
      ...code.matchAll(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm),
    ]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value)),
  );
  return {
    imports,
    exports,
    members: [...classMembers(code), ...topLevelMembers(code)].slice(0, 60),
  };
}

function parseVue(
  path: string,
  text: string,
): {
  imports: string[];
  exports: string[];
  members: ScanMember[];
} {
  const scriptMatches = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  const scripts = scriptMatches.map((match) => match[1] ?? "").join("\n");
  if (!scripts.trim()) return { imports: [], exports: [], members: [] };
  const parsed = parseTypeScript(scripts);
  return {
    ...parsed,
    exports: parsed.exports.length > 0 ? parsed.exports : [basename(path).replace(/\.vue$/, "")],
  };
}

function parsePython(text: string): {
  imports: string[];
  exports: string[];
  members: ScanMember[];
} {
  const code = stripComments(text);
  const imports = unique(
    [
      ...code.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm),
      ...code.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)/gm),
    ]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value)),
  );
  const classes = [...code.matchAll(/^\s*class\s+([A-Za-z_]\w*)/gm)].map(
    (match) => match[1] as string,
  );
  const functionMatches = [...code.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm)];
  const functions = functionMatches.map((match) => match[1] as string);
  return {
    imports,
    exports: unique([...classes, ...functions]).slice(0, 80),
    members: functionMatches
      .slice(0, 60)
      .map((match) => ({ name: match[1] as string, kind: "method" as const })),
  };
}

function parseJvm(text: string): {
  imports: string[];
  exports: string[];
  members: ScanMember[];
} {
  const code = stripComments(text);
  const imports = unique(
    [...code.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+);?/gm)]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value)),
  );
  const classes = [
    ...code.matchAll(
      /(?:^|\n)\s*(?:(?:public|private|protected|abstract|final|open|data|sealed)\s+)*(?:class|interface|enum|object|record)\s+([A-Za-z_]\w*)/g,
    ),
  ].map((match) => match[1] as string);
  const funcMatches = [
    ...code.matchAll(/(?:^|\n)\s*fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/g),
    ...code.matchAll(
      /(?:^|\n)\s*(?:public|private|protected|static|final|abstract|synchronized|native|override|suspend|open|internal|inline|operator|infix|tailrec|external|actual|expect)\s+(?:[\w<>,[\] ?]+\s+)?([A-Za-z_]\w*)\s*\(/g,
    ),
  ];
  const funcs = funcMatches.map((match) => match[1] as string);
  return {
    imports,
    exports: unique([...classes, ...funcs]).slice(0, 80),
    members: funcMatches
      .slice(0, 60)
      .map((match) => ({ name: match[1] as string, kind: "method" as const })),
  };
}

function parseGo(text: string): {
  imports: string[];
  exports: string[];
  members: ScanMember[];
} {
  const code = stripComments(text);
  const imports = unique(
    [
      ...code.matchAll(/^\s*import\s+"([^"]+)"/gm),
      ...code.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm),
    ].flatMap((match) => {
      if (match[0].includes("(")) {
        return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? "");
      }
      return [match[1] ?? ""];
    }),
  );
  const types = [...code.matchAll(/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm)].map(
    (match) => match[1] as string,
  );
  const funcMatches = [...code.matchAll(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm)];
  const funcs = funcMatches.map((match) => match[1] as string);
  return {
    imports,
    exports: unique([...types, ...funcs]).slice(0, 80),
    members: funcMatches
      .slice(0, 60)
      .map((match) => ({ name: match[1] as string, kind: "method" as const })),
  };
}

function parseFile(
  path: string,
  text: string,
): {
  imports: string[];
  exports: string[];
  members: ScanMember[];
  language: string;
} {
  const extension = extname(path).toLowerCase();
  if (extension === ".vue") {
    return { ...parseVue(path, text), language: "vue" };
  }
  if (extension === ".py") {
    return { ...parsePython(text), language: "python" };
  }
  if (extension === ".java" || extension === ".kt" || extension === ".kts") {
    return { ...parseJvm(text), language: extension === ".java" ? "java" : "kotlin" };
  }
  if (extension === ".go") {
    return { ...parseGo(text), language: "go" };
  }
  return {
    ...parseTypeScript(text),
    language: extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx" : "typescript",
  };
}

function resolveImport(
  root: string,
  importer: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | null {
  if (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("@/") &&
    !specifier.startsWith("~/")
  ) {
    return null;
  }
  const clean = specifier.split("?")[0]?.split("#")[0] ?? specifier;
  let base: string;
  if (clean.startsWith("@/")) base = join("src", clean.slice(2));
  else if (clean.startsWith("~/")) base = clean.slice(2);
  else if (clean.startsWith("/")) base = clean.slice(1);
  else base = join(dirname(importer), clean);
  base = toPosix(base);
  if (base.startsWith("..")) return null;
  const candidates = [base];
  const extension = extname(base);
  if (extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
    const without = base.slice(0, -extension.length);
    candidates.push(`${without}.ts`, `${without}.tsx`, `${without}.js`, `${without}.jsx`);
  }
  if (!extension) {
    for (const ext of SOURCE_EXTENSIONS) candidates.push(`${base}${ext}`);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(`${base}/index${ext}`);
  }
  for (const candidate of candidates) {
    const normalized = candidate.replace(/^\.\//, "");
    if (files.has(normalized)) return normalized;
    if (existsSync(resolve(root, normalized)) && files.has(normalized)) return normalized;
  }
  return null;
}

function packageName(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function moduleNodesForDirectory(
  dir: string,
  modules: Map<string, ArchNodeDraft>,
  systemId: string,
): ArchNodeDraft {
  const existing = modules.get(dir);
  if (existing) return existing;
  const segments = dir.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? dir;
  let parentId = systemId;
  if (segments.length > 1) {
    const parentPath = segments.slice(0, -1).join("/");
    parentId = moduleNodesForDirectory(parentPath, modules, systemId).id;
  }
  const node: ArchNodeDraft = {
    id: stableIds.node("module", dir),
    level: "L0",
    kind: segments.length === 1 ? "layer" : "module",
    parentId,
    name,
    path: dir,
    file: "",
    symbol: "",
    responsibility: `Contains ${name} source units.`,
    intentId: null,
    status: "active",
    metadata: { origin: "scan", directory: dir, depth: segments.length },
  };
  modules.set(dir, node);
  return node;
}

export function scanProject(
  root: string,
  config: JinConfig,
  options: ScanOptions = {},
): ScanResult {
  const collected = collectFiles(root, config, options);
  const fileSet = new Set(collected.files.map((file) => relativePath(root, file)));
  const warnings = [...collected.warnings];
  const files: ScannedFile[] = [];
  const manifest: ScanManifest = {};

  for (const absolute of collected.files) {
    if (options.signal?.aborted) throw new Error("Scan cancelled");
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    const path = relativePath(root, absolute);
    if (stats.size > MAX_BYTES) {
      warnings.push(`Skipped large file: ${path}`);
      continue;
    }
    const cached = options.manifest?.[path];
    const cacheHit =
      cached !== undefined &&
      cached.parserVersion === SCANNER_PARSER_VERSION &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.size === stats.size;
    let structural: {
      imports: string[];
      exports: string[];
      members: ScanMember[];
      language: string;
    };
    let lines: number;
    let exports: string[];
    let kind: L1Kind;
    let title: string;
    let responsibility: string;
    if (cacheHit && cached) {
      structural = {
        imports: cached.imports,
        exports: cached.exports,
        members: cached.members,
        language: cached.language,
      };
      lines = cached.lines;
      exports = cached.exports;
      kind = cached.kind;
      title = cached.title;
      responsibility = cached.responsibility;
    } else {
      let text: string;
      try {
        text = readFileSync(absolute, "utf8");
      } catch {
        warnings.push(`Could not read ${path}`);
        continue;
      }
      structural = parseFile(path, text);
      lines = text.split("\n").length;
      exports = unique(structural.exports);
      kind = classifyKind(path, exports, text);
      title = basename(path).startsWith("index.")
        ? basename(dirname(path)) || basename(path)
        : basename(path).replace(/\.[^.]+$/, "");
      const doc = firstDocComment(text);
      responsibility =
        doc ||
        (exports.length > 0
          ? `Provides ${exports.slice(0, 4).join(", ")}${exports.length > 4 ? "…" : ""}.`
          : `${kind} source unit.`);
    }
    manifest[path] = {
      parserVersion: SCANNER_PARSER_VERSION,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      language: structural.language,
      lines,
      imports: unique(structural.imports),
      exports: structural.exports,
      members: structural.members,
      kind,
      title,
      responsibility,
    };
    // LSP members are merged on every scan so stale symbols never outlive a server.
    const members = [...structural.members];
    const memberIndexes = new Map(
      members.map((member, index) => [`${member.kind}:${member.name}`, index]),
    );
    const symbolLocations: Record<string, { line: number; character?: number }> = {};
    for (const fact of options.lspFacts?.get(path) ?? []) {
      if (fact.line && !symbolLocations[fact.name]) {
        symbolLocations[fact.name] = {
          line: fact.line,
          ...(fact.character ? { character: fact.character } : {}),
        };
      }
      const key = `${fact.kind}:${fact.name}`;
      const existingIndex = memberIndexes.get(key);
      if (existingIndex !== undefined) {
        if (fact.line && !members[existingIndex]?.line) {
          members[existingIndex] = {
            ...members[existingIndex]!,
            line: fact.line,
            ...(fact.character ? { character: fact.character } : {}),
          };
        }
        continue;
      }
      if (members.length >= 60) continue;
      memberIndexes.set(key, members.length);
      members.push({
        name: fact.name,
        kind: fact.kind,
        ...(fact.line ? { line: fact.line } : {}),
        ...(fact.character ? { character: fact.character } : {}),
      });
    }
    files.push({
      path,
      absolute,
      language: structural.language,
      lines,
      symbolLocations,
      bytes: stats.size,
      imports: unique(structural.imports),
      exports,
      members,
      kind,
      title,
      responsibility,
    });
  }

  const systemId = stableIds.system(config.project.name);
  const nodes: ArchNodeDraft[] = [
    {
      id: systemId,
      level: "L0",
      kind: "system",
      parentId: null,
      name: config.project.name,
      path: "",
      file: "",
      symbol: "",
      responsibility: `System architecture for ${config.project.name}.`,
      intentId: null,
      status: "active",
      metadata: { origin: "scan", scanned: true },
    },
  ];
  const modules = new Map<string, ArchNodeDraft>();
  const fileNodes = new Map<string, ArchNodeDraft>();
  const externalNodes = new Map<string, ArchNodeDraft>();
  const edges: ArchEdgeDraft[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string, kind: ArchEdgeDraft["kind"], to: string): void => {
    if (from === to) return;
    const key = `${from}|${kind}|${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      id: stableIds.edge(from, kind, to),
      from,
      to,
      kind,
      metadata: { origin: "scan" },
    });
  };

  const dirs = new Set<string>();
  for (const file of files) {
    const dir = dirname(file.path);
    if (dir && dir !== ".") {
      const parts = dir.split("/");
      for (let index = 1; index <= parts.length; index += 1) {
        dirs.add(parts.slice(0, index).join("/"));
      }
    }
  }
  const sortedDirs = [...dirs].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  for (const dir of sortedDirs) {
    const node = moduleNodesForDirectory(dir, modules, systemId);
    if (!nodes.some((candidate) => candidate.id === node.id)) nodes.push(node);
  }
  for (const module of modules.values()) {
    addEdge(module.parentId ?? systemId, "contains", module.id);
  }

  for (const file of files) {
    const parentDir = dirname(file.path) === "." ? null : dirname(file.path);
    const parent = parentDir ? moduleNodesForDirectory(parentDir, modules, systemId) : null;
    const fileNode: ArchNodeDraft = {
      id: stableIds.node("file", file.path),
      level: "L1",
      kind: file.kind,
      parentId: parent?.id ?? systemId,
      name: file.title,
      path: file.path,
      file: file.path,
      symbol: "",
      responsibility: file.responsibility,
      intentId: null,
      status: "active",
      metadata: {
        origin: "scan",
        scanned: true,
        language: file.language,
        lines: file.lines,
        bytes: file.bytes,
        imports: file.imports,
        exports: file.exports,
        symbolLocations: file.symbolLocations,
        scanKind: file.kind,
      },
    };
    fileNodes.set(file.path, fileNode);
    nodes.push(fileNode);
    addEdge(fileNode.parentId ?? systemId, "contains", fileNode.id);

    const seenMembers = new Set<string>();
    for (const member of file.members) {
      const key = `${member.kind}:${member.name}`;
      if (seenMembers.has(key)) continue;
      seenMembers.add(key);
      const facet: ArchNodeDraft = {
        id: stableIds.facet(fileNode.id, key),
        level: "facet",
        kind: member.kind,
        parentId: fileNode.id,
        name: member.name,
        path: file.path,
        file: file.path,
        symbol: `#${member.name}`,
        responsibility: `${member.kind} ${member.name} on ${file.title}.`,
        intentId: null,
        status: "active",
        metadata: {
          origin: "scan",
          scanned: true,
          language: file.language,
          ...(member.line ? { line: member.line } : {}),
          ...(member.character ? { character: member.character } : {}),
        },
      };
      nodes.push(facet);
      addEdge(fileNode.id, "contains", facet.id);
    }
  }

  for (const file of files) {
    const from = fileNodes.get(file.path);
    if (!from) continue;
    for (const specifier of file.imports) {
      const resolved = resolveImport(root, file.path, specifier, fileSet);
      if (resolved) {
        const target = fileNodes.get(resolved);
        if (target) addEdge(from.id, "depends_on", target.id);
        continue;
      }
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (specifier.startsWith("@/") || specifier.startsWith("~/")) continue;
      const name = packageName(specifier);
      if (!name) continue;
      let external = externalNodes.get(name);
      if (!external) {
        external = {
          id: stableIds.node("external", name),
          level: "L0",
          kind: "external",
          parentId: systemId,
          name,
          path: `external/${name}`,
          file: "",
          symbol: "",
          responsibility: `External dependency ${name}.`,
          intentId: null,
          status: "active",
          metadata: { origin: "scan", scanned: true, package: name },
        };
        externalNodes.set(name, external);
        nodes.push(external);
        addEdge(systemId, "depends_on", external.id);
      }
      addEdge(from.id, "depends_on", external.id);
    }
  }

  const languageCounts: Record<string, number> = {};
  for (const file of files) {
    languageCounts[file.language] = (languageCounts[file.language] ?? 0) + 1;
  }
  const symbols = files.reduce((sum, file) => sum + file.exports.length + file.members.length, 0);
  return {
    files,
    nodes,
    edges,
    warnings,
    stats: {
      files: files.length,
      symbols,
      imports: files.reduce((sum, file) => sum + file.imports.length, 0),
      nodes: nodes.length,
      edges: edges.length,
      languages: languageCounts,
    },
    scannedAt: new Date().toISOString(),
    manifest,
  };
}

/** A deterministic file key for verification and RAG. */
export function fileNodeId(path: string): string {
  return stableIds.node("file", path);
}

/** Lightweight source listing for LSP discovery; does not read file bodies. */
export function listSourceFiles(
  root: string,
  config: JinConfig,
  options: ScanOptions = {},
): { files: string[]; warnings: string[] } {
  const collected = collectFiles(root, config, options);
  return {
    files: collected.files.map((file) => relativePath(root, file)),
    warnings: collected.warnings,
  };
}

export function scanRootPath(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

export function nodeKindLabel(kind: NodeKind): string {
  return kind;
}
