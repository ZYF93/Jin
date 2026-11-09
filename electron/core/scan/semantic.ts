import type { L1Kind } from "../../../shared/ledger/types";
import { isProviderConfigured } from "../../../shared/provider";
import {
  completeJson,
  ProviderError,
  type ProviderConfig,
  type ProviderTokenUsage,
} from "../agent/provider";
import type { ScanResult } from "./scanner";

const L1_KINDS: ReadonlySet<string> = new Set<L1Kind>([
  "component",
  "hook",
  "entity",
  "service",
  "repository",
  "route",
  "store",
  "type",
  "module",
  "function",
  "table",
  "schema",
  "config",
]);

const MAX_RESPONSIBILITY = 280;
const MAX_DOMAIN = 48;
const MAX_SYMBOLS = 24;
const MAX_FILES = 160;

export interface SemanticFileRefinement {
  path: string;
  kind?: L1Kind;
  responsibility?: string;
  domain?: string;
  symbols: string[];
}

export interface SemanticModuleRefinement {
  path: string;
  responsibility?: string;
  domain?: string;
}

export interface SemanticRefinement {
  files: SemanticFileRefinement[];
  modules: SemanticModuleRefinement[];
  warnings: string[];
}

export interface SemanticPassResult {
  scan: ScanResult;
  summary: string;
  warnings: string[];
}

export interface SemanticPassOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  onUsage?: (usage: ProviderTokenUsage) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Normalize a project-relative path without accepting absolute/escaping paths. */
export function semanticPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .trim();
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:\//.test(clean)) return null;
  if (clean.split("/").some((part) => part === ".." || part === "")) return null;
  return clean;
}

function knownSymbols(file: ScanResult["files"][number]): Set<string> {
  return new Set([...file.exports, ...file.members.map((member) => member.name)]);
}

/**
 * Validate model output against the structural/LSP facts. The model may only
 * classify files and symbols that actually exist in the scan; hallucinated
 * paths, kinds and symbols are dropped instead of entering the architecture.
 */
export function parseSemanticRefinement(value: unknown, scan: ScanResult): SemanticRefinement {
  const warnings: string[] = [];
  if (!isRecord(value) || !Array.isArray(value.files)) {
    return {
      files: [],
      modules: [],
      warnings: ["Semantic pass returned no file refinements."],
    };
  }

  const files = new Map(scan.files.map((file) => [file.path, file]));
  const modules = new Map(scan.nodes.filter(isScanModule).map((node) => [node.path, node]));
  const refined = new Map<string, SemanticFileRefinement>();
  const refinedModules = new Map<string, SemanticModuleRefinement>();
  let unknownPaths = 0;
  let rejectedSymbols = 0;

  for (const raw of value.files) {
    if (!isRecord(raw)) continue;
    const path = semanticPath(raw.path);
    const file = path ? files.get(path) : undefined;
    if (!path || !file) {
      unknownPaths += 1;
      continue;
    }

    const kind =
      typeof raw.kind === "string" && L1_KINDS.has(raw.kind) ? (raw.kind as L1Kind) : undefined;
    const responsibility = cleanText(raw.responsibility, MAX_RESPONSIBILITY);
    const domain = cleanText(raw.domain, MAX_DOMAIN).toLowerCase();
    const known = knownSymbols(file);
    const symbols: string[] = [];
    if (Array.isArray(raw.symbols)) {
      for (const symbol of raw.symbols) {
        if (typeof symbol !== "string") continue;
        const name = symbol.trim();
        if (!name) continue;
        if (!known.has(name)) {
          rejectedSymbols += 1;
          continue;
        }
        if (!symbols.includes(name)) symbols.push(name);
        if (symbols.length >= MAX_SYMBOLS) break;
      }
    }

    if (!kind && !responsibility && !domain && symbols.length === 0) continue;
    refined.set(path, {
      path,
      ...(kind ? { kind } : {}),
      ...(responsibility ? { responsibility } : {}),
      ...(domain ? { domain } : {}),
      symbols,
    });
  }

  let unknownModules = 0;
  if (Array.isArray(value.modules)) {
    for (const raw of value.modules) {
      if (!isRecord(raw)) continue;
      const path = semanticPath(raw.path);
      if (!path || !modules.has(path)) {
        unknownModules += 1;
        continue;
      }
      const responsibility = cleanText(raw.responsibility, MAX_RESPONSIBILITY);
      const domain = cleanText(raw.domain, MAX_DOMAIN).toLowerCase();
      if (!responsibility && !domain) continue;
      refinedModules.set(path, {
        path,
        ...(responsibility ? { responsibility } : {}),
        ...(domain ? { domain } : {}),
      });
    }
  }

  if (unknownPaths > 0) {
    warnings.push(
      `Semantic pass ignored ${unknownPaths} path${unknownPaths === 1 ? "" : "s"} that ${unknownPaths === 1 ? "is" : "are"} not in the structural scan.`,
    );
  }
  if (rejectedSymbols > 0) {
    warnings.push(
      `Semantic pass rejected ${rejectedSymbols} symbol${rejectedSymbols === 1 ? "" : "s"} not confirmed by LSP or structural facts.`,
    );
  }
  if (unknownModules > 0) {
    warnings.push(
      `Semantic pass ignored ${unknownModules} module path${unknownModules === 1 ? "" : "s"} that ${unknownModules === 1 ? "is" : "are"} not in the structural scan.`,
    );
  }
  return {
    files: [...refined.values()],
    modules: [...refinedModules.values()],
    warnings,
  };
}

function isScanModule(node: ScanResult["nodes"][number]): boolean {
  return (
    node.level === "L0" && node.kind !== "system" && node.kind !== "external" && Boolean(node.path)
  );
}

/**
 * Apply validated semantic refinements to both source facts and the L0/L1
 * drafts. L0 IDs stay path-derived so a semantic pass cannot destabilize the
 * architecture; domains are attached as metadata and summarized on the
 * containing modules.
 */
export function applySemanticRefinement(
  scan: ScanResult,
  refinement: SemanticRefinement,
): { scan: ScanResult; refined: number } {
  if (refinement.files.length === 0 && refinement.modules.length === 0) {
    return { scan, refined: 0 };
  }
  const byPath = new Map(refinement.files.map((file) => [file.path, file]));
  const moduleByPath = new Map(refinement.modules.map((module) => [module.path, module]));
  let refined = 0;

  const files = scan.files.map((file) => {
    const match = byPath.get(file.path);
    if (!match) return file;
    refined += 1;
    return {
      ...file,
      kind: match.kind ?? file.kind,
      responsibility: match.responsibility ?? file.responsibility,
    };
  });

  const domainByPath = new Map<string, string>();
  for (const file of refinement.files) {
    if (file.domain) domainByPath.set(file.path, file.domain);
  }

  const nodes = scan.nodes.map((node) => {
    if (isScanModule(node)) {
      const module = moduleByPath.get(node.path);
      if (module) {
        refined += 1;
        return {
          ...node,
          responsibility: module.responsibility ?? node.responsibility,
          metadata: {
            ...node.metadata,
            semantic: true,
            ...(module.domain ? { domains: [module.domain] } : {}),
            ...(module.domain ? { domain: module.domain } : {}),
          },
        };
      }
    }
    if (node.level === "L1" && node.file) {
      const match = byPath.get(node.file);
      if (!match) return node;
      const structuralKind =
        typeof node.metadata.scanKind === "string" ? node.metadata.scanKind : node.kind;
      return {
        ...node,
        kind: match.kind ?? node.kind,
        responsibility: match.responsibility ?? node.responsibility,
        metadata: {
          ...node.metadata,
          scanKind: structuralKind,
          semantic: true,
          ...(match.domain ? { domain: match.domain } : {}),
          ...(match.symbols.length > 0 ? { semanticSymbols: match.symbols } : {}),
        },
      };
    }

    if (!isScanModule(node)) return node;
    const prefix = `${node.path}/`;
    const domains = new Set<string>();
    let count = 0;
    for (const [path, domain] of domainByPath) {
      if (path === node.path || path.startsWith(prefix)) {
        domains.add(domain);
        count += 1;
      }
    }
    if (domains.size === 0) return node;
    const sorted = [...domains].sort();
    const summary =
      sorted.length === 1
        ? `Domain ${sorted[0]}: ${count} source unit${count === 1 ? "" : "s"} in ${node.name}.`
        : `Domains ${sorted.slice(0, 4).join(", ")}${sorted.length > 4 ? "…" : ""}: ${count} source units in ${node.name}.`;
    return {
      ...node,
      responsibility: moduleByPath.get(node.path)?.responsibility ?? summary,
      metadata: {
        ...node.metadata,
        semantic: true,
        domains: sorted.slice(0, 12),
        ...(moduleByPath.get(node.path)?.domain
          ? { domain: moduleByPath.get(node.path)?.domain }
          : {}),
      },
    };
  });

  return {
    scan: {
      ...scan,
      files,
      nodes,
    },
    refined,
  };
}

function promptFiles(scan: ScanResult): Array<Record<string, unknown>> {
  return scan.files.slice(0, MAX_FILES).map((file) => ({
    path: file.path,
    language: file.language,
    currentKind: file.kind,
    exports: file.exports.slice(0, 8),
    members: file.members.slice(0, 10).map((member) => member.name),
    imports: file.imports.slice(0, 6),
    currentResponsibility: file.responsibility.slice(0, 160),
  }));
}

function promptModules(scan: ScanResult): Array<Record<string, string>> {
  return scan.nodes
    .filter(isScanModule)
    .slice(0, 40)
    .map((node) => ({
      path: node.path,
      name: node.name,
      kind: node.kind,
    }));
}

const SYSTEM_PROMPT = `You are Jin's semantic architecture pass. You do not write code and you never invent files.
For each source file in the input, refine its architecture metadata:
- kind: one of component, hook, entity, service, repository, route, store, type, module, function, table, schema, config. Use module for ordinary files that are not clearly another kind; function is only for files whose primary role is reusable function behavior.
- responsibility: one concrete sentence (at most 280 characters) about behavior, not a restatement of the filename.
- domain: a short lowercase product domain shared by related files (for example billing, editor-shell, auth); do not use src or layer names.
- symbols: optional names that already appear in the file's exports or members; never guess a symbol.
For each listed source directory, return its responsibility: describe the product or technical capability its child files jointly provide, not that it contains files or was scanned.
Rules:
- Only return file and module paths present in the input.
- Prefer the current kind unless the code clearly belongs to another kind.
- Group related files under the same domain tag so L0 modules gain a semantic summary.
- Do not output Markdown or commentary.
Return strict JSON only:
{"files":[{"path":"src/example.ts","kind":"service","responsibility":"Charges a saved payment method and records the result.","domain":"billing","symbols":["charge"]}],"modules":[{"path":"src/billing","responsibility":"Coordinates payment creation, refunds, and invoice state.","domain":"billing"}]}`;

/**
 * Run one bounded semantic pass over a structural scan. Failure is non-fatal:
 * scanning must still work with an unavailable or flaky provider, so callers
 * receive the original facts plus a warning.
 */
export async function runSemanticPass(
  scan: ScanResult,
  provider: ProviderConfig,
  options: SemanticPassOptions = {},
): Promise<SemanticPassResult> {
  if (scan.files.length === 0 || !isProviderConfigured(provider)) {
    return { scan, summary: "", warnings: [] };
  }

  const user = JSON.stringify(
    {
      files: promptFiles(scan),
      modules: promptModules(scan),
      omittedFiles: Math.max(0, scan.files.length - MAX_FILES),
    },
    null,
    2,
  );

  try {
    const json = await completeJson(provider, SYSTEM_PROMPT, user, {
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 4000,
      timeoutMs: options.timeoutMs ?? 60_000,
      json: true,
      signal: options.signal,
      onUsage: options.onUsage,
    });
    const refinement = parseSemanticRefinement(json, scan);
    const applied = applySemanticRefinement(scan, refinement);
    if (applied.refined === 0) {
      return {
        scan,
        summary: "",
        warnings: [
          "Semantic pass completed, but no file or module refinement passed validation.",
          ...refinement.warnings,
        ],
      };
    }
    const domains = new Set(
      refinement.files
        .map((file) => file.domain)
        .filter((domain): domain is string => Boolean(domain)),
    );
    return {
      scan: applied.scan,
      summary: `Semantic pass refined ${applied.refined} project node${applied.refined === 1 ? "" : "s"} across ${domains.size} domain${domains.size === 1 ? "" : "s"}.`,
      warnings: refinement.warnings,
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const message =
      error instanceof ProviderError || error instanceof Error ? error.message : String(error);
    return {
      scan,
      summary: "",
      warnings: [`Semantic pass failed; structural facts were kept: ${message}`],
    };
  }
}
