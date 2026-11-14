import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ArchOp, ArchSnapshot, Intent } from "../../../shared/ledger/types";
import type { ReuseCandidate, ReusePlan } from "../../../shared/ipc";
import { applyUnifiedPatchFile, parseUnifiedPatch } from "./patch";
import { normalizeProjectPath } from "./path-safety";
import type { ProviderConfig } from "./provider";
import { resilientProviderFetch } from "./provider";
import { runShell, shellResultText } from "./shell";
import { runProjectChecks } from "../verify/verify";
import { grepFiles, globFiles } from "./code-search";
import { TodoList } from "./todo";
import { fetchPage, searchWeb } from "./web";
import { runHooks } from "./hooks";

export { normalizeProjectPath } from "./path-safety";

export const MAX_STAGED_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 200 * 1024;
const MAX_ARCHITECTURE_NODES = 320;
const MAX_ARCHITECTURE_EDGES = 480;
const MAX_EKO_STEPS = 32;
const configuredEkoModules = new WeakSet<object>();

export interface StagedEdit {
  path: string;
  content?: string;
  delete?: boolean;
}

/**
 * Virtual file system used by the Eko tool loop. Eko may read real files, but
 * every write/delete is staged in memory until the run finishes. The session
 * then applies the staged edits through its existing atomic writer, after the
 * run has been cancelled, audited or discarded as a whole.
 */
export class StagedWorkspace {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly staged = new Map<string, { content: string | null }>();
  private readonly diskWrites = new Set<string>();

  constructor(root: string, maxBytes = MAX_STAGED_BYTES) {
    this.root = root;
    this.maxBytes = maxBytes;
  }

  get size(): number {
    return this.staged.size;
  }

  read(path: string): string {
    const relative = normalizeProjectPath(path);
    const pending = this.staged.get(relative);
    if (pending) {
      if (pending.content === null) throw new Error(`File was deleted in this run: ${relative}`);
      return pending.content;
    }
    const rootReal = realpathSync(this.root);
    const absolute = resolve(rootReal, relative);
    if (absolute !== rootReal && !absolute.startsWith(`${rootReal}${sep}`)) {
      throw new Error(`File escapes the workspace: ${relative}`);
    }
    if (!existsSync(absolute)) throw new Error(`File does not exist: ${relative}`);
    const real = realpathSync(absolute);
    if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`)) {
      throw new Error(`File resolves outside the workspace: ${relative}`);
    }
    const stats = statSync(absolute);
    if (!stats.isFile()) throw new Error(`Not a file: ${relative}`);
    if (stats.size > MAX_READ_BYTES) {
      throw new Error(`File is larger than ${Math.round(MAX_READ_BYTES / 1024)} KB: ${relative}`);
    }
    const buffer = readFileSync(absolute);
    if (buffer.includes(0)) throw new Error(`Binary file cannot be read as text: ${relative}`);
    return buffer.toString("utf8");
  }

  stageWrite(path: string, content: string): { path: string; bytes: number } {
    const relative = normalizeProjectPath(path);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxBytes) {
      throw new Error(
        `Content exceeds the ${Math.round(this.maxBytes / 1024)} KB edit limit: ${relative}`,
      );
    }
    this.staged.set(relative, { content });
    this.diskWrites.add(relative);
    return { path: relative, bytes };
  }

  stageDelete(path: string): { path: string; existed: boolean } {
    const relative = normalizeProjectPath(path);
    const existed = this.staged.has(relative)
      ? this.staged.get(relative)?.content !== null
      : existsSync(join(this.root, relative));
    this.staged.set(relative, { content: null });
    this.diskWrites.add(relative);
    return { path: relative, existed };
  }

  /**
   * Apply a unified diff to the staged view without touching disk. New files
   * must use `--- /dev/null`; a patch against an existing file is applied to
   * the pending staged content when the same run already wrote it.
   */
  stagePatch(
    patchText: string,
    fallbackPath?: string,
  ): Array<{ path: string; isNew: boolean; isDelete: boolean }> {
    const files = parseUnifiedPatch(patchText, fallbackPath);
    const results: Array<{ path: string; isNew: boolean; isDelete: boolean }> = [];
    for (const file of files) {
      const pending = this.staged.get(file.path);
      const existsOnDisk = existsSync(join(this.root, file.path));
      const current = pending ? pending.content : existsOnDisk ? this.read(file.path) : null;
      if (file.isNew) {
        if (current !== null) {
          throw new Error(
            `File already exists: ${file.path}. Patch it instead of creating it, or use write_file.`,
          );
        }
        const content = applyUnifiedPatchFile("", file);
        if (content === null) throw new Error(`New-file patch produced no content: ${file.path}`);
        this.stageWrite(file.path, content);
      } else if (file.isDelete) {
        if (current === null) throw new Error(`Cannot delete a missing file: ${file.path}`);
        const content = applyUnifiedPatchFile(current, file);
        if (content !== null) {
          throw new Error(`Deletion patch for ${file.path} did not remove the whole file`);
        }
        this.stageDelete(file.path);
      } else {
        if (current === null) {
          throw new Error(
            `File does not exist: ${file.path}. Use a new-file patch with --- /dev/null or write_file.`,
          );
        }
        const content = applyUnifiedPatchFile(current, file);
        if (content === null) throw new Error(`Patch unexpectedly deleted ${file.path}`);
        this.stageWrite(file.path, content);
      }
      results.push({ path: file.path, isNew: file.isNew, isDelete: file.isDelete });
    }
    return results;
  }

  /** Only changed files, in stable path order, converted to session edit records. */
  toEdits(): StagedEdit[] {
    return [...this.staged.entries()]
      .filter(([path]) => this.diskWrites.has(path))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, value]) =>
        value.content === null ? { path, delete: true as const } : { path, content: value.content },
      );
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Compact architecture context for the coder. The full JSON snapshot can be
 * enormous; the agent only needs identities, paths, responsibilities and
 * relationships to keep code aligned with the approved layers.
 */
export function architectureSummary(snapshot: ArchSnapshot, intent: Intent | null = null): string {
  const nodes = Object.values(snapshot.nodes).sort((left, right) => {
    const order = { L0: 0, L1: 1, facet: 2 } as const;
    if (left.level !== right.level) return order[left.level] - order[right.level];
    return left.name.localeCompare(right.name);
  });
  const lines = nodes.slice(0, MAX_ARCHITECTURE_NODES).map((node) => {
    const parent = node.parentId ? ` parent=${node.parentId}` : "";
    return `${node.id} | ${node.level}/${node.kind} | ${node.name} | file=${node.file || "-"} | ${clip(node.responsibility, 160)}${parent}`;
  });
  if (nodes.length > MAX_ARCHITECTURE_NODES) {
    lines.push(`… ${nodes.length - MAX_ARCHITECTURE_NODES} more nodes omitted.`);
  }
  const edges = Object.values(snapshot.edges)
    .slice(0, MAX_ARCHITECTURE_EDGES)
    .map((edge) => `${edge.from} -[${edge.kind}]-> ${edge.to}`);
  const parts = [
    `ARCHITECTURE (${nodes.length} nodes, ${Object.keys(snapshot.edges).length} edges)`,
    ...lines,
  ];
  if (edges.length > 0) parts.push("EDGES", ...edges);
  if (intent) {
    parts.push(
      "CURRENT INTENT",
      `${intent.title}: ${intent.goal}`,
      ...intent.nodeIntents.map(
        (item) => `- ${item.nodeId}${item.facetId ? `#${item.facetId}` : ""}: ${item.statement}`,
      ),
    );
  }
  return parts.join("\n");
}

function toolResult(
  text: string,
  isError = false,
): { content: [{ type: "text"; text: string }]; isError?: boolean } {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export type EkoModule = typeof import("@eko-ai/eko");

export interface EkoMcpTool {
  /** Namespaced tool name: `mcp__server__tool`. */
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<string>;
}

export interface EkoCoderInput {
  root: string;
  provider: ProviderConfig;
  system: string;
  task: string;
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
  snapshot: ArchSnapshot;
  intent: Intent;
  ops: ArchOp[];
  reusePlan: ReusePlan | null;
  searchCode: (query: string, limit?: number) => ReuseCandidate[];
  /** MCP tools exposed to the agent, in addition to Jin's built-ins. */
  mcpTools?: readonly EkoMcpTool[];
  /** Optional configured search endpoint for the web_search tool. */
  webSearch?: { endpoint?: string; apiKey?: string | null };
  /** Images the user attached, forwarded to the implementation model via the OpenAI layer. */
  images?: readonly import("./provider").ImageAttachment[];
  onProgress?: (message: string) => void;
  /** Cumulative assistant text from Eko, forwarded as a transient chat stream. */
  onText?: (text: string, done: boolean) => void;
  /** Cumulative thinking text from reasoning models, forwarded separately. */
  onThinking?: (text: string, done: boolean) => void;
  /** One visible tool call / result / error row for the chat activity feed. */
  onActivity?: (entry: { tool: string; detail: string; isError?: boolean }) => void;
  /** Todo list snapshot, emitted whenever the agent rewrites it. */
  onTodos?: (summary: string, list: string) => void;
  /** Per-LLM-call token telemetry from Eko's stream finish events. */
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}

export interface EkoCoderResult {
  edits: StagedEdit[];
  summary: string;
  notes: string[];
  warnings: string[];
  todos: string[];
}

export interface EkoCoderDeps {
  load?: () => Promise<EkoModule>;
}

/**
 * Wrap a fetch so the first OpenAI `user` message in every request carries the
 * attached images as `image_url` parts. Eko drives its LLM through the OpenAI
 * protocol, so this is how vision reaches the implementation model without
 * touching Eko's internal message plumbing.
 */
export function withImageFetch(
  base: typeof fetch,
  images: readonly import("./provider").ImageAttachment[],
): typeof fetch {
  if (images.length === 0) return base;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    let body = init?.body;
    if (body && typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as {
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        const user = Array.isArray(parsed.messages)
          ? parsed.messages.find((message) => message.role === "user")
          : undefined;
        if (user && typeof user.content === "string") {
          user.content = [
            ...(user.content ? [{ type: "text", text: user.content }] : []),
            ...images.map((image) => ({
              type: "image_url",
              image_url: { url: image.dataUrl },
            })),
          ];
        }
        body = JSON.stringify(parsed);
      } catch {
        // Leave the body untouched if it is not the expected shape.
      }
    }
    return base(input, body !== undefined ? { ...init, body } : init);
  }) as typeof fetch;
}

export function ekoLlmConfig(input: EkoCoderInput): {
  provider: "openai-compatible";
  model: string;
  apiKey: string;
  fetch: typeof fetch;
  config: { baseURL: string; temperature: number; maxOutputTokens: number };
} {
  let baseURL = input.provider.baseUrl.replace(/\/+$/, "");
  if (input.provider.kind === "anthropic") {
    // Eko speaks the OpenAI protocol; Anthropic exposes an OpenAI-compatible
    // layer at /v1/chat/completions (Bearer auth), so normalize the base URL.
    baseURL = baseURL.endsWith("/v1") ? baseURL : `${baseURL}/v1`;
  }
  if (input.provider.kind === "gemini") {
    // Google offers an OpenAI-compatible layer at /v1beta/openai/chat/completions.
    const root = baseURL
      .replace(/\/v1beta$/, "")
      .replace(/\/v1$/, "")
      .replace(/\/openai$/, "");
    baseURL = `${root}/v1beta/openai`;
  }
  return {
    provider: "openai-compatible",
    model: input.provider.model,
    apiKey: input.provider.apiKey || "jin-local",
    fetch: resilientProviderFetch,
    config: {
      baseURL,
      temperature: input.temperature,
      maxOutputTokens: input.maxTokens,
    },
  };
}

function toolArgsPreview(params: Record<string, unknown> | undefined): string {
  if (!params || typeof params !== "object") return "";
  if (typeof params.path === "string" && params.path) {
    return typeof params.cwd === "string" && params.cwd
      ? `${params.path} (in ${params.cwd})`
      : String(params.path);
  }
  if (typeof params.command === "string" && params.command) {
    return clip(params.command, 160);
  }
  if (typeof params.query === "string" && params.query) {
    return clip(params.query, 160);
  }
  return clip(JSON.stringify(params), 140);
}

/** Compact one-line preview of a tool result for the activity feed. */
function toolResultPreview(result: unknown): string {
  let text = "";
  if (typeof result === "string") text = result;
  else if (Array.isArray((result as { content?: unknown })?.content)) {
    text = ((result as { content: Array<{ text?: unknown }> }).content ?? [])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n");
  } else if (result !== null && typeof result === "object") {
    text = JSON.stringify(result);
  }
  const trimmed = text.trim();
  if (!trimmed) return "(empty result)";
  return clip(trimmed, 220);
}

/**
 * Run one Eko 4.x agent loop against the approved architecture. Eko is loaded
 * lazily so a missing optional dependency cannot prevent Jin from starting.
 * The loop is deliberately bounded: 32 tool steps is enough for a focused
 * version and prevents a runaway model from burning tokens indefinitely.
 */
export async function runEkoCoder(
  input: EkoCoderInput,
  deps: EkoCoderDeps = {},
): Promise<EkoCoderResult> {
  if (input.signal.aborted) throw new Error("Implementation cancelled");
  const load = deps.load ?? (() => import("@eko-ai/eko"));
  let module: EkoModule;
  try {
    module = await load();
  } catch (error) {
    throw new Error(
      `Eko runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const workspace = new StagedWorkspace(input.root);
  const warnings: string[] = [];
  const todos = new TodoList();
  const architecture = architectureSummary(input.snapshot, input.intent);
  const reuse = input.reusePlan
    ? JSON.stringify(input.reusePlan, null, 2)
    : "No ReusePlan was built for this version.";

  /**
   * Wrap a tool so configured `.jin/hooks.json` rules run around it. Pre-tool
   * hooks can veto the call; post-tool hooks are audit-only.
   */
  const builtins: import("@eko-ai/eko").Tool[] = [
    {
      name: "grep",
      description:
        "Search source files with a regular expression. Returns file:line matches. Use for exact symbol, string or import lookups; prefer this over search_code when you know what text to find.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression." },
          path: {
            type: "string",
            description: "Optional project-relative sub-directory to search.",
          },
          glob: { type: "string", description: "Optional file filter, e.g. *.ts or src/**/*.tsx." },
          ignoreCase: { type: "boolean", description: "Case-insensitive search." },
          limit: { type: "number", description: "Maximum matches, 1-500 (default 80)." },
        },
        required: ["pattern"],
      },
      supportParallelCalls: true,
      execute: async (args) => {
        const pattern = typeof args.pattern === "string" ? args.pattern : "";
        if (!pattern) return toolResult("Error: pattern is required", true);
        try {
          const result = grepFiles(input.root, pattern, {
            path: typeof args.path === "string" ? args.path : undefined,
            glob: typeof args.glob === "string" ? args.glob : undefined,
            ignoreCase: args.ignoreCase === true,
            limit: typeof args.limit === "number" ? args.limit : undefined,
            signal: input.signal,
          });
          if (result.hits.length === 0) {
            return toolResult(`No matches in ${result.filesScanned} files.`);
          }
          const body = result.hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join("\n");
          return toolResult(`${body}${result.truncated ? "\n… [results truncated]" : ""}`);
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
      description:
        "List project files matching a glob pattern such as src/**/*.ts. Use to discover files before reading them.",
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
        if (!pattern) return toolResult("Error: pattern is required", true);
        const result = globFiles(
          input.root,
          pattern,
          typeof args.limit === "number" ? args.limit : 200,
        );
        if (result.paths.length === 0) return toolResult("No files matched.");
        return toolResult(`${result.paths.join("\n")}${result.truncated ? "\n… [truncated]" : ""}`);
      },
    },
    {
      name: "todo_write",
      description:
        "Create or replace the task list for this implementation. Rewrite the whole list each call: mark exactly one item in_progress, completed items stay completed. Use it for any multi-step task so the user sees progress.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "Full list, in order.",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "Short imperative task." },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
      execute: async (args) => {
        const text = todos.write(args.todos);
        input.onTodos?.(todos.summary(), text);
        input.onProgress?.(`todo: ${todos.summary()}`);
        return toolResult(text);
      },
    },
    {
      name: "todo_read",
      description: "Read the current task list.",
      parameters: { type: "object", properties: {} },
      supportParallelCalls: true,
      execute: async () => toolResult(todos.read()),
    },
    {
      name: "fetch_url",
      description:
        "Fetch a public http(s) page and return readable text (HTML stripped). Use to read documentation, changelogs or API references. Private and local addresses are rejected.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." },
          maxChars: { type: "number", description: "Maximum characters to return (500-60000)." },
        },
        required: ["url"],
      },
      execute: async (args) => {
        const url = typeof args.url === "string" ? args.url : "";
        if (!url) return toolResult("Error: url is required", true);
        try {
          const page = await fetchPage(url, {
            maxChars: typeof args.maxChars === "number" ? args.maxChars : undefined,
            signal: input.signal,
          });
          const title = page.title ? `# ${page.title}\n\n` : "";
          return toolResult(`${title}${page.text}${page.truncated ? "\n… [truncated]" : ""}`);
        } catch (error) {
          return toolResult(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      },
    },
    {
      name: "web_search",
      description:
        "Search the web through the endpoint configured in Settings → Provider. Returns titles, URLs and snippets; follow up with fetch_url for details.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "number", description: "Maximum results, 1-20 (default 6)." },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const query = typeof args.query === "string" ? args.query : "";
        if (!query.trim()) return toolResult("Error: query is required", true);
        try {
          const hits = await searchWeb(query, {
            endpoint: input.webSearch?.endpoint,
            apiKey: input.webSearch?.apiKey,
            limit: typeof args.limit === "number" ? args.limit : undefined,
            signal: input.signal,
          });
          if (hits.length === 0) return toolResult("No results.");
          return toolResult(
            hits
              .map(
                (hit) =>
                  `${hit.title}\n${hit.url}${hit.snippet ? `\n${clip(hit.snippet, 400)}` : ""}`,
              )
              .join("\n\n"),
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
      name: "read_file",
      description: "Read a UTF-8 source file relative to the project root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Project-relative file path." } },
        required: ["path"],
      },
      supportParallelCalls: true,
      async execute(args) {
        const path = typeof args.path === "string" ? args.path : "";
        if (!path) return toolResult("Error: path is required", true);
        try {
          return toolResult(workspace.read(path));
        } catch (error) {
          return toolResult(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      },
    },
    {
      name: "write_file",
      description:
        "Stage a complete file (not a diff). Nothing touches disk until the run finishes and the approval-bound writer applies the staged edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path." },
          content: { type: "string", description: "Complete new file content." },
        },
        required: ["path", "content"],
      },
      async execute(args) {
        const path = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : "";
        if (!path) return toolResult("Error: path is required", true);
        try {
          const staged = workspace.stageWrite(path, content);
          return toolResult(`Staged ${staged.path} (${staged.bytes} bytes).`);
        } catch (error) {
          return toolResult(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      },
    },
    {
      name: "apply_patch",
      description:
        "Stage a unified diff for one or more existing files. Standard ---/+++ headers select the paths; with hunk-only patches pass path. Nothing touches disk until the run finishes.",
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description:
              "Unified diff. Existing files use --- a/file and +++ b/file; new files use --- /dev/null; deletes use +++ /dev/null.",
          },
          path: {
            type: "string",
            description:
              "Optional project-relative target for a single-file patch that has no ---/+++ headers.",
          },
        },
        required: ["patch"],
      },
      async execute(args) {
        const patch = typeof args.patch === "string" ? args.patch : "";
        const path = typeof args.path === "string" ? args.path : "";
        if (!patch.trim()) return toolResult("Error: patch is required", true);
        try {
          const staged = workspace.stagePatch(patch, path || undefined);
          return toolResult(
            staged
              .map(
                (file) =>
                  `Staged ${file.isDelete ? "deletion of" : file.isNew ? "new file" : "patch to"} ${file.path}.`,
              )
              .join("\n"),
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
      name: "run_shell",
      description:
        "Run one bounded shell command inside the project (default 15s, max 30s, 32 KB output). Use for tests, builds and read-only inspection. Absolute paths, home shortcuts and destructive commands are rejected; every call is audited.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Single-line command." },
          cwd: {
            type: "string",
            description:
              "Optional project-relative working directory; defaults to the project root.",
          },
          timeoutMs: {
            type: "number",
            description: "Timeout in milliseconds, clamped to 1000-30000.",
          },
        },
        required: ["command"],
      },
      async execute(args) {
        const command = typeof args.command === "string" ? args.command : "";
        const cwd = typeof args.cwd === "string" ? args.cwd : "";
        const timeoutMs =
          typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
            ? args.timeoutMs
            : undefined;
        if (!command.trim()) return toolResult("Error: command is required", true);
        try {
          const result = await runShell({
            root: input.root,
            command,
            cwd: cwd || undefined,
            timeoutMs,
            signal: input.signal,
          });
          return toolResult(
            shellResultText(result),
            result.exitCode !== 0 && !result.timedOut ? true : false,
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
      name: "delete_file",
      description: "Stage deletion of a project file. Applied only after the run completes.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Project-relative file path." } },
        required: ["path"],
      },
      async execute(args) {
        const path = typeof args.path === "string" ? args.path : "";
        if (!path) return toolResult("Error: path is required", true);
        try {
          const staged = workspace.stageDelete(path);
          return toolResult(
            staged.existed
              ? `Staged deletion of ${staged.path}.`
              : `Staged deletion of ${staged.path} (file did not exist).`,
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
      name: "search_code",
      description:
        "Search the repository's reuse index for existing implementations before writing new code.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What behavior or symbol to look for." },
          limit: { type: "number", description: "Maximum results, 1-20." },
        },
        required: ["query"],
      },
      supportParallelCalls: true,
      async execute(args) {
        const query = typeof args.query === "string" ? args.query : "";
        if (!query.trim()) return toolResult("Error: query is required", true);
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.max(1, Math.min(20, Math.trunc(args.limit)))
            : 8;
        try {
          const results = input.searchCode(query, limit);
          if (results.length === 0) return toolResult("No existing implementation matched.");
          return toolResult(
            results
              .map(
                (result) =>
                  `${result.path} | ${result.symbol || "-"} | score ${result.score}\n${clip(result.snippet, 700)}`,
              )
              .join("\n\n"),
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
      name: "run_checks",
      description:
        "Run the project's own typecheck/test/lint scripts and report each result with its failing output. Call it to verify your implementation before finishing; fix any failing check.",
      parameters: { type: "object", properties: {} },
      async execute() {
        try {
          const checks = await runProjectChecks(input.root);
          if (checks.length === 0) return toolResult("No project checks to run.");
          const lines = checks.map((check) => {
            const detail = check.detail.slice(0, 2_000);
            return `[${check.status.toUpperCase()}] ${check.name}${detail ? `:\n${detail}` : ""}`;
          });
          const failed = checks.filter((check) => check.status === "fail").length;
          return toolResult(
            `${checks.length - failed}/${checks.length} checks passed.\n\n${lines.join("\n\n")}`,
            failed > 0,
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
      name: "view_image",
      description:
        "Load an image file (png/jpg/gif/webp) from the project and return it to the model as a data URL so it can be seen when the provider supports vision. Returns the data URL plus dimensions and byte size. Non-vision models will simply not perceive it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative image file path." },
        },
        required: ["path"],
      },
      supportParallelCalls: true,
      async execute(args) {
        const path = typeof args.path === "string" ? args.path : "";
        if (!path) return toolResult("Error: path is required", true);
        try {
          const relative = normalizeProjectPath(path);
          const absolute = resolve(input.root, relative);
          if (!existsSync(absolute)) return toolResult(`No such image: ${path}`, true);
          const stat = statSync(absolute);
          if (!stat.isFile()) return toolResult(`${path} is not a file`, true);
          if (stat.size > 4 * 1024 * 1024) return toolResult("Image is larger than 4 MB", true);
          const mime =
            (
              {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
                bmp: "image/bmp",
              } as const
            )[absolute.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
          const base64 = readFileSync(absolute).toString("base64");
          return toolResult(
            [`Loaded ${path} (${stat.size} bytes, ${mime}).`, `data:${mime};base64,${base64}`].join(
              "\n",
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
      name: "architecture",
      description:
        "Read the approved L0/L1/facet architecture plus the current intent, structural ops and ReusePlan.",
      parameters: { type: "object", properties: {} },
      supportParallelCalls: true,
      async execute() {
        return toolResult(
          [
            architecture,
            "APPROVED OPS",
            JSON.stringify(input.ops, null, 2),
            "REUSEPLAN",
            reuse,
          ].join("\n\n"),
        );
      },
    },
  ];

  const mcpTools: import("@eko-ai/eko").Tool[] = (input.mcpTools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as import("@eko-ai/eko").Tool["parameters"],
    supportParallelCalls: true,
    execute: async (args: Record<string, unknown>) => {
      try {
        return toolResult(await tool.call(args));
      } catch (error) {
        return toolResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  }));

  // Every tool runs the project's hooks; pre-tool hooks can veto a call.
  const tools: import("@eko-ai/eko").Tool[] = [...builtins, ...mcpTools].map((tool) => ({
    ...tool,
    execute: async (args: Record<string, unknown>) => {
      if (input.signal.aborted) return toolResult("Error: cancelled", true);
      const pre = await runHooks({
        root: input.root,
        event: "preToolUse",
        tool: tool.name,
        args,
        signal: input.signal,
      });
      if (pre.blocked) return toolResult(`Error: ${pre.message}`, true);
      const result = await tool.execute?.(args, undefined as never, undefined as never);
      if (result === undefined) return toolResult("Error: tool produced no result", true);
      const post = await runHooks({
        root: input.root,
        event: "postToolUse",
        tool: tool.name,
        args,
        signal: input.signal,
      });
      if (post.ran.length > 0) input.onProgress?.(`hook: ${tool.name}`);
      return result;
    },
  }));

  const moduleConfig = module.config;
  if (!configuredEkoModules.has(module)) {
    moduleConfig.maxReactNum = MAX_EKO_STEPS;
    configuredEkoModules.add(module);
  }
  const system = input.system;
  // Project hooks get a chance to prepare or veto the implementation.
  const beforeImplement = await runHooks({
    root: input.root,
    event: "beforeImplement",
    signal: input.signal,
    timeoutMs: 30_000,
  });
  if (beforeImplement.blocked) throw new Error(beforeImplement.message);
  class JinAgent extends module.Agent {
    protected async extSysPrompt(): Promise<string> {
      return system;
    }
  }
  const agent = new JinAgent({
    name: "jin_coder",
    description:
      "Implements one approved Jin architecture version by staging complete source files. It never commits and never edits the ledger.",
    tools,
    planDescription: "Implementation of an approved architecture diff.",
  });
  const taskId = `jin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const workflow = module.buildSimpleAgentWorkflow({
    taskId,
    name: "Implement approved architecture",
    agentName: "jin_coder",
    task: input.task,
  });
  const eko = new module.Eko({
    llms: {
      default: {
        ...ekoLlmConfig(input),
        fetch: withImageFetch(resilientProviderFetch, input.images ?? []),
      },
    },
    agents: [agent],
    callback: {
      async onMessage(message) {
        if (
          (message.type === "text" || message.type === "thinking") &&
          typeof message.text === "string"
        ) {
          if (message.type === "thinking") {
            input.onThinking?.(message.text, Boolean(message.streamDone));
          } else {
            input.onText?.(message.text, Boolean(message.streamDone));
          }
        } else if (message.type === "tool_use" && typeof message.toolName === "string") {
          input.onProgress?.(`Eko: ${message.toolName}`);
          input.onActivity?.({
            tool: message.toolName,
            detail: toolArgsPreview(message.params),
          });
        } else if (message.type === "tool_result" && typeof message.toolName === "string") {
          input.onActivity?.({
            tool: message.toolName,
            detail: toolResultPreview(message.toolResult),
            isError: Boolean((message.toolResult as { isError?: unknown } | undefined)?.isError),
          });
        } else if (message.type === "error") {
          input.onActivity?.({
            tool: "error",
            detail: clip(
              message.error instanceof Error ? message.error.message : String(message.error),
              220,
            ),
            isError: true,
          });
        } else if (message.type === "agent_start") {
          input.onProgress?.("Eko: agent started");
        } else if (message.type === "finish" && "usage" in message && message.usage) {
          input.onUsage?.({
            promptTokens: Number(message.usage.promptTokens ?? 0),
            completionTokens: Number(message.usage.completionTokens ?? 0),
          });
        }
      },
    },
  });

  try {
    await eko.initContext(workflow, { datetime: new Date().toISOString() });
    const onAbort = (): void => {
      eko.abortTask(taskId, "Implementation cancelled");
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (input.signal.aborted) throw new Error("Implementation cancelled");
      const result = await eko.execute(taskId);
      if (input.signal.aborted || result.stopReason === "abort") {
        throw new Error("Implementation cancelled");
      }
      if (!result.success) {
        throw new Error(`Eko failed: ${clip(result.result || "unknown error", 1200)}`);
      }
      const edits = workspace.toEdits();
      if (edits.length === 0) {
        warnings.push("Eko completed without staging any file changes.");
      }
      return {
        edits,
        summary:
          result.result.trim() || `${edits.length} file${edits.length === 1 ? "" : "s"} staged.`,
        notes: [],
        warnings,
        todos: todos.read().startsWith("No todos") ? [] : todos.read().split("\n"),
      };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  } finally {
    try {
      eko.deleteTask(taskId);
    } catch {
      // Task cleanup is best effort.
    }
  }
}
