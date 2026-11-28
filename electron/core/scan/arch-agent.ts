import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchNodeDraft, L1Kind, NodeKind } from "../../../shared/arch/types";
import type { LspFacts } from "../lsp/client";
import type { ProviderConfig, ProviderTokenUsage } from "../agent/provider";
import { resilientProviderFetch } from "../agent/provider";
import { configuredEkoModules, type EkoModule } from "../agent/eko-runtime";
import { grepFiles, globFiles } from "../agent/code-search";
import type { ScanResult, ScannedFile } from "./scanner";
import { stableIds } from "../ids/stable";

/**
 * The architecture scan is a single agent-driven design pass, not a
 * "preset tree + per-node fill-in". The model is handed the whole
 * structural/LSP picture up front, given read-only tools to inspect the
 * source it needs, and asked to assemble the L0/L1/facet tree itself and
 * submit it in one structured call. Structural facts (which files exist,
 * their exports/imports/members) stay authoritative; the agent only supplies
 * the *design* — grouping, kinds, responsibilities and domains.
 */

// The Eko tool loop re-sends the whole context every step, so the real lever
// is keeping each tool result small (see compactText) rather than cutting the
// run short. Steps/token limits are generous safety nets, not the primary cap.
const MAX_EKO_STEPS = 24;
const MAX_DESIGN_NODES = 400;
const MAX_RESPONSIBILITY = 280;
const MAX_DOMAIN = 48;
const MAX_SYMBOLS_PER_FILE = 24;
/** Max files listed in the initial design context (keeps the prompt bounded). */
const MAX_CONTEXT_FILES = 200;
/** Default/max lines a single read_file returns. */
const READ_LINES = 200;
/** Max characters a single tool result contributes to the transcript. */
const MAX_READ_CHARS = 6000;
/** Total source lines the agent may read across the whole design. */
const MAX_TOTAL_READ_LINES = 4000;
/**
 * Last-resort ceiling on tokens the design may consume before we abort and
 * keep whatever was submitted. Set high so normal completions never hit it;
 * it only stops a truly runaway loop.
 */
const MAX_DESIGN_TOKENS = 1_200_000;

export interface ArchitectureDesignInput {
  root: string;
  provider: ProviderConfig;
  scan: ScanResult;
  lspFacts?: LspFacts;
  /** AGENTS.md rules (project + global) the design must respect. */
  rules?: string;
  temperature?: number;
  maxTokens?: number;
  signal: AbortSignal;
  /**
   * Restrict the design to these unit paths (a retry over only the units a
   * prior pass left undescribed). When omitted, the whole project is designed.
   */
  only?: { files: string[]; modules: string[] };
  onUsage?: (usage: ProviderTokenUsage) => void;
  onProgress?: (message: string) => void;
  /** Override the Eko module loader (for tests). Defaults to importing the real module. */
  load?: () => Promise<EkoModule>;
}

export interface ArchitectureDesignResult {
  /** The structural scan with the LLM design grafted onto its nodes/files. */
  scan: ScanResult;
  /** The LLM-designed L0/L1/facet nodes that were applied. */
  designed: ArchNodeDraft[];
  warnings: string[];
  /** True when the model submitted and the design was applied to the scan. */
  applied: boolean;
  summary: string;
}

const L1_KINDS: ReadonlySet<string> = new Set<string>([
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
  "method",
  "field",
  "property",
]);

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Compact a tool result before it enters the transcript. The Eko loop re-sends
 * the whole history every step, so trimming noise (blank lines, runs of
 * whitespace, over-long lines) keeps each step cheap without losing meaning.
 */
function compactText(text: string, maxChars: number): string {
  const trimmed = text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line, index, arr) => !(line === "" && arr[index - 1] === ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n… [truncated]` : trimmed;
}

/** Normalize a project-relative path; reject absolute/escaping paths. */
function relPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .trim();
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:\//.test(clean)) return null;
  if (clean.split("/").some((part) => part === ".." || part === "")) return null;
  return clean;
}

/** Compact, token-budgeted structural + LSP context for the design prompt. */
function buildContext(
  scan: ScanResult,
  lspFacts: LspFacts | undefined,
  onlyPaths: Set<string> | null,
): string {
  const files = onlyPaths ? scan.files.filter((file) => onlyPaths.has(file.path)) : scan.files;
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const dir = file.path.slice(0, file.path.lastIndexOf("/")) || ".";
    const base = file.path.split("/").filter(Boolean).pop() ?? file.path;
    const list = byDir.get(dir) ?? [];
    if (!list.includes(base)) list.push(base);
    byDir.set(dir, list);
  }
  const symbolCountByPath = new Map<string, number>();
  for (const symbol of lspFacts?.symbols ?? []) {
    symbolCountByPath.set(symbol.path, (symbolCountByPath.get(symbol.path) ?? 0) + 1);
  }
  const fileLines = files
    .slice(0, MAX_CONTEXT_FILES)
    .map((file) => {
      const lsp = symbolCountByPath.get(file.path) ?? 0;
      const parts = [
        `${file.path} [${file.language}]`,
        `exports: ${file.exports.slice(0, 8).join(", ") || "none"}`,
      ];
      if (file.imports.length > 0) {
        parts.push(`imports: ${file.imports.slice(0, 8).join(", ")}`);
      }
      if (lsp > 0) parts.push(`symbols(LSP): ${lsp}`);
      return parts.join(" | ");
    })
    .join("\n");
  const layout = [...byDir.entries()]
    .map(([dir, names]) => `${dir}/: ${names.slice(0, 30).join(", ")}`)
    .join("\n");
  return [
    `LAYOUT (directories -> files, first 30 each):\n${layout}`,
    ``,
    `FILES (path | exports | imports | LSP symbol count), ${files.length} files${
      files.length > MAX_CONTEXT_FILES ? ` (showing first ${MAX_CONTEXT_FILES})` : ""
    }:`,
    fileLines,
  ].join("\n");
}

export async function runArchitectureDesignAgent(
  input: ArchitectureDesignInput,
): Promise<ArchitectureDesignResult> {
  const warnings: string[] = [];
  const load = input.load ?? (async (): Promise<EkoModule> => import("@eko-ai/eko"));
  let module: EkoModule;
  try {
    module = await load();
  } catch (error) {
    return {
      scan: input.scan,
      designed: [],
      warnings: [
        `Eko runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ],
      applied: false,
      summary: "Architecture design agent unavailable.",
    };
  }

  const fileSet = new Set(input.scan.files.map((file) => file.path));
  const structuralByPath = new Map(input.scan.files.map((file) => [file.path, file]));

  // The single structured design output. Populated by submit_architecture.
  let submitted: {
    nodes: ArchNodeDraft[];
  } | null = null;
  const submittedNodes = (): ArchNodeDraft[] => (submitted ? submitted.nodes : []);
  /** Source lines read so far, capped to keep the tool loop cheap. */
  let totalReadLines = 0;
  /** Cumulative tokens spent by the design; aborts the loop past the budget. */
  let spentTokens = 0;

  const toolResult = (
    text: string,
    isError = false,
  ): { content: [{ type: "text"; text: string }]; isError?: boolean } =>
    isError
      ? { content: [{ type: "text", text }], isError: true }
      : { content: [{ type: "text", text }] };

  const lspSymbolsByPath = new Map<string, string[]>();
  for (const symbol of input.lspFacts?.symbols ?? []) {
    const list = lspSymbolsByPath.get(symbol.path) ?? [];
    const entry = symbol.detail ? `${symbol.name} (${symbol.detail})` : symbol.name;
    if (!list.includes(entry) && list.length < MAX_SYMBOLS_PER_FILE) list.push(entry);
    lspSymbolsByPath.set(symbol.path, list);
  }

  const tools: import("@eko-ai/eko").Tool[] = [
    {
      name: "read_file",
      description: "Read a UTF-8 source file relative to the project root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path." },
          maxLines: { type: "number", description: "Maximum lines to return (default 200)." },
        },
        required: ["path"],
      },
      supportParallelCalls: true,
      execute: async (args) => {
        const path = relPath(args.path);
        if (!path) return toolResult("Error: path is required and must be project-relative.", true);
        try {
          const abs = join(input.root, path);
          const text = readFileSync(abs, "utf8");
          const requested = typeof args.maxLines === "number" ? args.maxLines : READ_LINES;
          const remaining = MAX_TOTAL_READ_LINES - totalReadLines;
          if (remaining <= 0) {
            return toolResult(
              "Read budget exhausted; design from what you have and call submit_architecture now.",
            );
          }
          const limit = Math.max(1, Math.min(requested, READ_LINES, remaining));
          totalReadLines += limit;
          const lines = text.split("\n");
          const body = compactText(lines.slice(0, limit).join("\n"), MAX_READ_CHARS);
          return toolResult(`${body}${lines.length > limit ? "\n… [truncated]" : ""}`);
        } catch (error) {
          return toolResult(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      },
    },
    {
      name: "grep",
      description:
        "Search source files with a regular expression. Returns file:line matches. Use for exact symbol/string/import lookups.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression." },
          path: { type: "string", description: "Optional sub-directory." },
          glob: { type: "string", description: "Optional file filter, e.g. *.ts." },
          limit: { type: "number", description: "Maximum matches, 1-500 (default 80)." },
        },
        required: ["pattern"],
      },
      supportParallelCalls: true,
      execute: async (args) => {
        const pattern = typeof args.pattern === "string" ? args.pattern : "";
        if (!pattern) return toolResult("Error: pattern is required.", true);
        try {
          const result = grepFiles(input.root, pattern, {
            path: typeof args.path === "string" ? args.path : undefined,
            glob: typeof args.glob === "string" ? args.glob : undefined,
            limit: Math.min(typeof args.limit === "number" ? args.limit : 40, 60),
          });
          if (result.hits.length === 0)
            return toolResult(`No matches in ${result.filesScanned} files.`);
          const body = result.hits
            .slice(0, 40)
            .map((hit) => `${hit.path}:${hit.line}: ${hit.text.trim().slice(0, 200)}`)
            .join("\n");
          return toolResult(
            compactText(
              `${body}${result.truncated ? "\n… [results truncated]" : ""}`,
              MAX_READ_CHARS,
            ),
          );
        } catch (error) {
          return toolResult(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      },
    },
    {
      name: "glob",
      description: "List project files matching a glob pattern such as src/**/*.ts.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.ts." },
          limit: { type: "number", description: "Maximum paths, 1-1000 (default 200)." },
        },
        required: ["pattern"],
      },
      supportParallelCalls: true,
      execute: async (args) => {
        const pattern = typeof args.pattern === "string" ? args.pattern : "";
        if (!pattern) return toolResult("Error: pattern is required.", true);
        const result = globFiles(
          input.root,
          pattern,
          typeof args.limit === "number" ? args.limit : 200,
        );
        if (result.paths.length === 0) return toolResult("No files matched.");
        const body = result.paths.slice(0, 200).join("\n");
        return toolResult(
          compactText(`${body}${result.truncated ? "\n… [truncated]" : ""}`, MAX_READ_CHARS),
        );
      },
    },
    {
      name: "lsp_symbols",
      description:
        "Return the LSP document symbols (functions/classes/methods/fields) collected for a file. Use to name facets and ground a file's role in its real API surface.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path." },
        },
        required: ["path"],
      },
      supportParallelCalls: true,
      execute: async (args) => {
        const path = relPath(args.path);
        if (!path) return toolResult("Error: path is required.", true);
        const symbols = lspSymbolsByPath.get(path);
        if (!symbols || symbols.length === 0)
          return toolResult(`No LSP symbols recorded for ${path}.`);
        const file = structuralByPath.get(path);
        const members = file
          ? `structural members: ${file.members.map((member) => member.name).join(", ") || "none"}`
          : "structural members: unknown";
        return toolResult(`LSP symbols for ${path}:\n- ${symbols.join("\n- ")}\n${members}`);
      },
    },
    {
      name: "submit_architecture",
      description:
        "Submit the final architecture design. Call it exactly once, after you have read enough. Provide the L0/L1/facet nodes: their paths must be real files or directories from the context, kinds must be valid, and every node needs a concrete responsibility. Do not invent files.",
      parameters: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            description: "The full designed node tree.",
            items: {
              type: "object",
              properties: {
                level: {
                  type: "string",
                  enum: ["L0", "L1", "facet"],
                  description: "L0 = module/directory, L1 = file, facet = exported member.",
                },
                path: {
                  type: "string",
                  description: "Directory (L0) or file (L1/facet) path, project-relative.",
                },
                name: { type: "string", description: "Short display name." },
                kind: {
                  type: "string",
                  description:
                    "e.g. module/layer/domain, service/component/function/…, method/field/property.",
                },
                parentId: {
                  type: "string",
                  description: "Parent node id, or null for the system root.",
                },
                responsibility: {
                  type: "string",
                  description:
                    "One concrete sentence: what this unit does for the system (not what it is).",
                },
                domain: { type: "string", description: "Optional short lowercase product domain." },
              },
              required: ["level", "path", "responsibility"],
            },
          },
        },
        required: ["nodes"],
      },
      execute: async (args) => {
        if (!Array.isArray(args.nodes)) {
          return toolResult("Error: nodes must be an array.", true);
        }
        const nodes: ArchNodeDraft[] = [];
        const seenPaths = new Set<string>();
        let invalid = 0;
        for (const raw of args.nodes as Array<Record<string, unknown>>) {
          if (!raw) continue;
          const kind = typeof raw.kind === "string" ? raw.kind : "";
          const level = raw.level;
          const path = relPath(raw.path);
          if (!path || (!L1_KINDS.has(kind) && !levelAllowed(level))) {
            invalid += 1;
            continue;
          }
          const responsibility = cleanText(raw.responsibility, MAX_RESPONSIBILITY);
          if (!responsibility) {
            invalid += 1;
            continue;
          }
          // L1 and facets must map to a real scanned file. L0 must be a real
          // directory (or contain one); we validate against the scanned set.
          const isFile = level === "L1" || level === "facet";
          if (isFile && !fileSet.has(path)) {
            invalid += 1;
            continue;
          }
          if (isFile && seenPaths.has(path)) continue;
          seenPaths.add(path);
          const structural = structuralByPath.get(path);
          const nodeKind = validKindFor(level, kind, structural?.kind);
          const symbol = typeof raw.symbol === "string" ? raw.symbol : "";
          const facetName = level === "facet" ? cleanText(raw.name, 64) : "";
          const node: ArchNodeDraft = {
            id:
              level === "L1"
                ? stableIds.node("file", path)
                : level === "facet"
                  ? stableIds.facet(stableIds.node("file", path), facetName || symbol || "f")
                  : stableIds.node("module", path),
            level: level as ArchNodeDraft["level"],
            kind: nodeKind,
            parentId: null,
            name:
              typeof raw.name === "string" && raw.name.trim()
                ? raw.name.trim()
                : (path.split("/").filter(Boolean).pop() ?? path),
            path,
            file: level === "L0" ? "" : path,
            symbol,
            responsibility,
            intentId: null,
            status: "active",
            metadata: {
              origin: "scan",
              scanned: true,
              semantic: true,
              ...(typeof raw.domain === "string" && raw.domain.trim()
                ? { domain: cleanText(raw.domain, MAX_DOMAIN).toLowerCase() }
                : {}),
            },
          };
          nodes.push(node);
          if (nodes.length >= MAX_DESIGN_NODES) break;
        }
        if (nodes.length === 0) {
          return toolResult(
            "Error: no valid nodes submitted (all paths/kinds were invalid).",
            true,
          );
        }
        submitted = { nodes };
        input.onProgress?.(
          `architecture submitted ${nodes.length} nodes${invalid ? `, ${invalid} invalid dropped` : ""}`,
        );
        return toolResult(
          `Accepted ${nodes.length} designed nodes${invalid ? ` (${invalid} invalid dropped)` : ""}. Finish by ending the task.`,
        );
      },
    },
  ];

  // Parent wiring is repaired deterministically after submission: an L1/facet
  // parent is its containing L0 directory; an L0's parent is its containing
  // directory L0, else the system root.
  const repairParents = (nodes: ArchNodeDraft[], systemId: string): ArchNodeDraft[] => {
    const l0ByPath = new Map<string, ArchNodeDraft>();
    for (const node of nodes) if (node.level === "L0") l0ByPath.set(node.path, node);
    const dirL0 = (path: string): ArchNodeDraft | null => {
      const parts = path.split("/");
      let dir = parts.length > 1 ? path.slice(0, path.lastIndexOf("/")) : "";
      while (dir) {
        const match = l0ByPath.get(dir);
        if (match) return match;
        const next = dir.slice(0, dir.lastIndexOf("/"));
        if (!next) break;
        dir = next;
      }
      return null;
    };
    return nodes.map((node) => {
      if (node.level === "L0") {
        const parentDir = dirL0(node.path);
        return { ...node, parentId: parentDir ? parentDir.id : systemId };
      }
      const parent = dirL0(node.path);
      return { ...node, parentId: parent ? parent.id : systemId };
    });
  };

  // The system root is whatever the structural scan already uses, so designed
  // L0 modules can parent to it without inventing an id.
  const systemNode = input.scan.nodes.find((node) => node.kind === "system");
  const systemId = systemNode?.id ?? stableIds.system("project");
  const onlyPaths = input.only
    ? new Set<string>([...input.only.files, ...input.only.modules])
    : null;
  const context = buildContext(input.scan, input.lspFacts, onlyPaths);
  const rules = input.rules?.trim();
  const system = [
    "You are Jin's architecture designer. Given a project's structural and LSP facts, design its architecture: L0 modules (directories), L1 files, and optional L0/facet members.",
    "Read source with read_file/grep/glob/lsp_symbols until you understand each unit's real role, then call submit_architecture ONCE with the full node tree.",
    "Every node needs a concrete responsibility: what it does for the system (not a restatement of the filename). Use AGENTS.md rules for vocabulary when present. Never invent files; paths must come from the context.",
    rules ? `\nPROJECT RULES (AGENTS.md):\n${rules}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const task = [
    "Design the architecture for this project and submit it.",
    "You already have every file's exports, imports and members in the context below — design most nodes from that alone. Only read_file/grep a file when its role is genuinely unclear; do not read files you can already classify.",
    "Work efficiently to save tokens: if you do read, read several files in parallel in one step and skim (small maxLines); never re-read a file.",
    "Cover as many files as you can in the single submit_architecture call — a partial design is fine, but aim to describe every file you have enough context for. Do not explore endlessly.",
    "You must finish by calling submit_architecture.",
    context,
  ].join("\n");

  let moduleConfig = module.config;
  if (!configuredEkoModules.has(module)) {
    moduleConfig.maxReactNum = MAX_EKO_STEPS;
    configuredEkoModules.add(module);
  }
  class JinArchAgent extends module.Agent {
    protected async extSysPrompt(): Promise<string> {
      return system;
    }
  }
  const agent = new JinArchAgent({
    name: "jin_architect",
    description:
      "Designs a project's architecture from structural and LSP facts, with read-only tools.",
    tools,
    planDescription: "Architecture design from scanned facts.",
  });
  const taskId = `jin-arch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const workflow = module.buildSimpleAgentWorkflow({
    taskId,
    name: "Design project architecture",
    agentName: "jin_architect",
    task,
  });
  const eko = new module.Eko({
    llms: {
      default: {
        provider: "openai-compatible",
        model: input.provider.model,
        apiKey: input.provider.apiKey || "jin-local",
        fetch: resilientProviderFetch,
        config: {
          baseURL: input.provider.baseUrl.replace(/\/+$/, ""),
          temperature: input.temperature ?? 0.2,
          maxOutputTokens: input.maxTokens ?? 8000,
        },
      },
    },
    agents: [agent],
    callback: {
      async onMessage(message) {
        if (message.type === "tool_use" && typeof message.toolName === "string") {
          input.onProgress?.(`architect: ${message.toolName}`);
        } else if (message.type === "finish" && "usage" in message && message.usage) {
          const promptTokens = Number(message.usage.promptTokens ?? 0);
          const completionTokens = Number(message.usage.completionTokens ?? 0);
          spentTokens += promptTokens + completionTokens;
          input.onUsage?.({ promptTokens, completionTokens });
          // Abort a runaway loop before it burns the whole budget without
          // submitting; whatever was submitted is still applied.
          if (spentTokens > MAX_DESIGN_TOKENS && submittedNodes().length === 0) {
            warnings.push(
              `Architecture design aborted at ${spentTokens} tokens (budget ${MAX_DESIGN_TOKENS}) without a submission.`,
            );
            eko.abortTask(taskId, "Architecture design token budget exceeded");
          }
        }
      },
    },
  });

  let lastError = "";
  let budgetAborted = false;
  try {
    await eko.initContext(workflow, { datetime: new Date().toISOString() });
    const onAbort = (): void => {
      eko.abortTask(taskId, "Architecture design cancelled");
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      let result = await eko.execute(taskId);
      // If the agent ended without submitting, give it one nudge to submit a
      // partial design before we give up. A truncated/failed run otherwise
      // leaves every node undescribed. Skip the nudge once the token budget is
      // spent, so a runaway loop cannot keep spending.
      if (
        submittedNodes().length === 0 &&
        !input.signal.aborted &&
        result.stopReason !== "abort" &&
        spentTokens <= MAX_DESIGN_TOKENS
      ) {
        warnings.push(
          `Architecture agent did not submit; nudging. Stop reason: ${result.stopReason || "unknown"}. ${String(result.result).slice(0, 160)}`,
        );
        input.onProgress?.("architecture: retrying submission");
        const nudged = await eko.execute(taskId);
        lastError = String(nudged.result).slice(0, 200);
        result = nudged;
      }
      if (input.signal.aborted) {
        throw new Error("Architecture design cancelled");
      }
      // A token-budget abort is not a user cancel: keep whatever was submitted.
      budgetAborted = result.stopReason === "abort" && spentTokens > MAX_DESIGN_TOKENS;
      if (!result.success && submittedNodes().length === 0 && !budgetAborted) {
        lastError = String(result.result).slice(0, 200);
      }
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  } finally {
    try {
      eko.deleteTask(taskId);
    } catch {
      // Task cleanup is best-effort.
    }
  }

  if (submittedNodes().length === 0) {
    if (lastError) warnings.push(`Architecture agent last error: ${lastError}`);
    return {
      scan: input.scan,
      designed: [],
      warnings,
      applied: false,
      summary: "Architecture design produced no usable design.",
    };
  }
  const repaired = repairParents(submittedNodes(), systemId);
  const scan = graftDesign(input.scan, repaired);
  return {
    scan,
    designed: repaired,
    warnings,
    applied: true,
    summary: `Architecture designed: ${repaired.length} nodes.`,
  };
}

/**
 * Graft the LLM-designed nodes onto a structural scan. The structural scan is
 * authoritative for file/edge facts and stable node ids; the design supplies
 * responsibilities, kinds, domains and parent wiring for L0/L1/facet nodes.
 * Matching is by path (L0/L1) and path+symbol (facets), so the design need
 * not know Jin's stable ids. Anything the design did not cover keeps its
 * structural (empty) description.
 */
function graftDesign(scan: ScanResult, designed: ArchNodeDraft[]): ScanResult {
  const designByPath = new Map<string, ArchNodeDraft>();
  const designByPathLevel = new Map<string, ArchNodeDraft>();
  const facetDesign = new Map<string, ArchNodeDraft>();
  for (const node of designed) {
    if (node.level === "facet") {
      facetDesign.set(`${node.path}|${node.symbol || node.name}`, node);
    } else {
      designByPath.set(node.path, node);
      designByPathLevel.set(`${node.path}|${node.level}`, node);
    }
  }
  const designFor = (node: ArchNodeDraft): ArchNodeDraft | undefined => {
    if (node.level === "facet") {
      return (
        facetDesign.get(`${node.path}|${node.symbol}`) ??
        facetDesign.get(`${node.path}|${node.name}`)
      );
    }
    if (node.level === "L0")
      return designByPathLevel.get(`${node.path}|L0`) ?? designByPath.get(node.path);
    return designByPathLevel.get(`${node.path}|L1`) ?? designByPath.get(node.path);
  };

  const files = scan.files.map((file) => {
    const design = designFor(nodeFromPath(file));
    if (!design) return file;
    const kind =
      design.kind === "method" || design.kind === "field" || design.kind === "property"
        ? file.kind
        : (design.kind as L1Kind);
    return {
      ...file,
      kind,
      responsibility: design.responsibility || file.responsibility,
    };
  });

  const nodes = scan.nodes.map((node) => {
    const design = designFor(node);
    if (!design) return node;
    return {
      ...node,
      kind: design.kind || node.kind,
      responsibility: design.responsibility || node.responsibility,
      metadata: {
        ...node.metadata,
        ...(typeof design.metadata.domain === "string"
          ? { domain: design.metadata.domain, domains: [design.metadata.domain] }
          : {}),
        semantic: true,
      },
    };
  });

  return {
    ...scan,
    files,
    nodes,
    stats: { ...scan.stats },
  };
}

function nodeFromPath(file: ScannedFile): ArchNodeDraft {
  return {
    id: "",
    level: "L1",
    kind: file.kind,
    parentId: null,
    name: file.title,
    path: file.path,
    file: file.path,
    symbol: "",
    responsibility: "",
    intentId: null,
    status: "active",
    metadata: {},
  };
}

function levelAllowed(level: unknown): boolean {
  return level === "L0" || level === "L1" || level === "facet";
}

function validKindFor(level: unknown, rawKind: unknown, structuralKind?: L1Kind): NodeKind {
  const candidate = typeof rawKind === "string" ? rawKind : "";
  if (level === "L0") {
    return candidate === "layer" || candidate === "domain" || candidate === "module"
      ? candidate
      : "module";
  }
  if (level === "facet") {
    return candidate === "method" || candidate === "field" || candidate === "property"
      ? candidate
      : "method";
  }
  if (L1_KINDS.has(candidate)) return candidate as NodeKind;
  return structuralKind ?? "module";
}
