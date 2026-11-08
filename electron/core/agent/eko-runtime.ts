import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArchOp, ArchSnapshot, Intent } from "../../../shared/arch/types";
import type { ReuseCandidate, ReusePlan } from "../../../shared/ipc";
import { applyUnifiedPatchFile, parseUnifiedPatch } from "./patch";
import { normalizeProjectPath } from "./path-safety";
import type { ProviderConfig } from "./provider";
import { resilientProviderFetch } from "./provider";
import { runShell, shellResultText } from "./shell";

export { normalizeProjectPath } from "./path-safety";

export const MAX_STAGED_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 200 * 1024;
const MAX_ARCHITECTURE_NODES = 320;
const MAX_ARCHITECTURE_EDGES = 480;

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
    const absolute = join(this.root, relative);
    if (!existsSync(absolute)) throw new Error(`File does not exist: ${relative}`);
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
  onProgress?: (message: string) => void;
  /** Cumulative assistant text from Eko, forwarded as a transient chat stream. */
  onText?: (text: string, done: boolean) => void;
  /** Per-LLM-call token telemetry from Eko's stream finish events. */
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}

export interface EkoCoderResult {
  edits: StagedEdit[];
  summary: string;
  notes: string[];
  warnings: string[];
}

export interface EkoCoderDeps {
  load?: () => Promise<EkoModule>;
}

export function ekoLlmConfig(input: EkoCoderInput): {
  provider: "openai-compatible";
  model: string;
  apiKey: string;
  fetch: typeof fetch;
  config: { baseURL: string; temperature: number; maxOutputTokens: number };
} {
  return {
    provider: "openai-compatible",
    model: input.provider.model,
    apiKey: input.provider.apiKey || "jin-local",
    fetch: resilientProviderFetch,
    config: {
      baseURL: input.provider.baseUrl,
      temperature: input.temperature,
      maxOutputTokens: input.maxTokens,
    },
  };
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
  const architecture = architectureSummary(input.snapshot, input.intent);
  const reuse = input.reusePlan
    ? JSON.stringify(input.reusePlan, null, 2)
    : "No ReusePlan was built for this version.";
  const tools: import("@eko-ai/eko").Tool[] = [
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

  const moduleConfig = module.config;
  const previousMax = moduleConfig.maxReactNum;
  moduleConfig.maxReactNum = 32;
  const system = input.system;
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
    llms: { default: ekoLlmConfig(input) },
    agents: [agent],
    callback: {
      async onMessage(message) {
        if (
          (message.type === "text" || message.type === "thinking") &&
          typeof message.text === "string"
        ) {
          input.onText?.(message.text, Boolean(message.streamDone));
        } else if (message.type === "tool_use" && typeof message.toolName === "string") {
          input.onProgress?.(`Eko: ${message.toolName}`);
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
      };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  } finally {
    moduleConfig.maxReactNum = previousMax;
    try {
      eko.deleteTask(taskId);
    } catch {
      // Task cleanup is best effort.
    }
  }
}
