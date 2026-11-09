import type {
  ArchSnapshot,
  L0Kind,
  L1Kind,
  NodeKind,
  NodeStatus,
} from "../../../shared/ledger/types";
import type { ProviderConfig } from "./provider";
import { completeJson, ProviderError } from "./provider";
import type {
  PlannedNodeAdd,
  PlannedOp,
  PlannedTask,
  PlanDraft,
  PlannerContext,
} from "./plan-types";

const L0_KINDS: ReadonlySet<string> = new Set<L0Kind>([
  "system",
  "domain",
  "module",
  "layer",
  "external",
]);
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
const FACET_KINDS: ReadonlySet<string> = new Set(["method", "field", "property"]);
const NODE_LEVELS: ReadonlySet<string> = new Set(["L0", "L1", "facet"]);
const NODE_STATUSES: ReadonlySet<string> = new Set(["active", "planned", "deprecated"]);
const EDGE_KINDS = new Set([
  "contains",
  "depends_on",
  "uses",
  "implements",
  "extends",
  "references",
  "renders",
  "reads",
  "writes",
  "constrains",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Serialize the approved architecture for the planner.
 *
 * `budgetChars` is derived from the configured context window and compaction
 * ratio. L0 is kept first because it anchors IDs; L1 and facets are then
 * compressed until the budget is exhausted.
 */
function architectureSummary(snapshot: ArchSnapshot, budgetChars = Infinity): string {
  const nodes = Object.values(snapshot.nodes).sort((a, b) => {
    if (a.level !== b.level) {
      const order = { L0: 0, L1: 1, facet: 2 };
      return order[a.level] - order[b.level];
    }
    return a.name.localeCompare(b.name);
  });
  const l0 = nodes.filter((node) => node.level === "L0");
  const l1 = nodes.filter((node) => node.level === "L1");
  const facets = nodes.filter((node) => node.level === "facet");
  const line = (node: (typeof nodes)[number]): string =>
    `- ${node.id} | ${node.level}/${node.kind} | ${node.name} | path=${node.path || "-"} | file=${node.file || "-"} | symbol=${node.symbol || "-"} | parent=${node.parentId ?? "-"} | ${node.responsibility}`;
  const lines: string[] = [
    `System: ${l0
      .filter((node) => node.kind === "system")
      .map((node) => node.name)
      .join(", ")}`,
    "L0:",
  ];
  let used = lines.join("\n").length;
  let omittedL1 = 0;
  let omittedFacets = 0;
  const append = (line: string): boolean => {
    if (used + line.length + 1 > budgetChars) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  for (const node of l0) {
    append(line(node));
  }
  const l1Header = `L1 (${l1.length}):`;
  lines.push(l1Header);
  used += l1Header.length + 1;
  for (const node of l1) {
    if (!append(line(node))) omittedL1 += 1;
  }
  const facetHeader = `Facets (${facets.length}):`;
  lines.push(facetHeader);
  used += facetHeader.length + 1;
  for (const node of facets) {
    if (!append(line(node))) omittedFacets += 1;
  }
  if (omittedL1 > 0 || omittedFacets > 0) {
    lines.push(
      `… compacted ${omittedL1} L1 and ${omittedFacets} facet nodes to fit the context budget. Prefer visible IDs; ask for a file search instead of inventing IDs.`,
    );
  }
  return lines.filter(Boolean).join("\n");
}

/** Characters available for architecture after prompt overhead and compaction. */
export function plannerContextBudget(contextWindow: number, compactionRatio: number): number {
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
  const ratio =
    Number.isFinite(compactionRatio) && compactionRatio > 0 ? Math.min(1, compactionRatio) : 0;
  const usableTokens = Math.max(1_000, window * ratio);
  // ~4 chars/token, half reserved for system prompt, request, and output.
  return Math.max(8_000, Math.floor(usableTokens * 4 * 0.5));
}

function parseTasks(value: unknown): PlannedTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: PlannedTask[] = [];
  for (const task of value) {
    if (!isRecord(task)) continue;
    const title = stringValue(task.title).trim();
    if (!title) continue;
    tasks.push({
      title: title.slice(0, 300),
      acceptance: stringArray(task.acceptance).map((item) => item.slice(0, 300)),
      dependsOn: stringArray(task.dependsOn),
    });
  }
  return tasks;
}

function parseNodeIntents(value: unknown): PlanDraft["nodeIntents"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const nodeId = stringValue(item.nodeId).trim();
      const statement = stringValue(item.statement).trim();
      if (!nodeId || !statement) return null;
      return {
        nodeId,
        facetId: stringValue(item.facetId).trim() || undefined,
        statement: statement.slice(0, 600),
        invariants: stringArray(item.invariants),
        acceptance: stringArray(item.acceptance),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function parseOps(value: unknown): PlannedOp[] {
  if (!Array.isArray(value)) return [];
  const ops: PlannedOp[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const op = raw.op;
    if (op === "node.add" && isRecord(raw.node)) {
      const node = raw.node;
      const level = stringValue(node.level);
      const kind = stringValue(node.kind);
      const name = stringValue(node.name).trim();
      if (!NODE_LEVELS.has(level) || !name) continue;
      if (level === "L0" && !L0_KINDS.has(kind)) continue;
      if (level === "L1" && !L1_KINDS.has(kind)) continue;
      if (level === "facet" && !FACET_KINDS.has(kind)) continue;
      const status = stringValue(node.status, "planned");
      const add: PlannedNodeAdd = {
        op: "node.add",
        node: {
          id: stringValue(node.id).trim() || undefined,
          level: level as PlannedNodeAdd["node"]["level"],
          kind: kind as NodeKind,
          parentId:
            typeof node.parentId === "string" && node.parentId.trim() ? node.parentId.trim() : null,
          name: name.slice(0, 160),
          path: stringValue(node.path),
          file: stringValue(node.file),
          symbol: stringValue(node.symbol),
          responsibility: stringValue(node.responsibility).slice(0, 600),
          intentId: null,
          status: NODE_STATUSES.has(status) ? (status as NodeStatus) : "planned",
          metadata: isRecord(node.metadata) ? node.metadata : {},
        },
      };
      ops.push(add);
      continue;
    }
    if (op === "node.update" && typeof raw.id === "string") {
      const patch = isRecord(raw.patch) ? raw.patch : {};
      const clean: Record<string, unknown> = {};
      for (const key of [
        "level",
        "kind",
        "parentId",
        "name",
        "path",
        "file",
        "symbol",
        "responsibility",
        "intentId",
        "status",
        "metadata",
      ]) {
        if (key in patch) clean[key] = patch[key];
      }
      ops.push({
        op: "node.update",
        id: raw.id,
        patch: clean as import("./plan-types").NodePatch,
      });
      continue;
    }
    if (op === "node.remove" && typeof raw.id === "string") {
      ops.push({ op: "node.remove", id: raw.id });
      continue;
    }
    if (op === "edge.add" && isRecord(raw.edge)) {
      const edge = raw.edge;
      if (
        typeof edge.id === "string" &&
        typeof edge.from === "string" &&
        typeof edge.to === "string" &&
        EDGE_KINDS.has(stringValue(edge.kind))
      ) {
        ops.push({
          op: "edge.add",
          edge: {
            id: edge.id,
            from: edge.from,
            to: edge.to,
            kind: stringValue(edge.kind) as import("../../../shared/ledger/types").EdgeKind,
            metadata: isRecord(edge.metadata) ? edge.metadata : {},
          },
        });
      }
      continue;
    }
    if (op === "edge.remove" && typeof raw.id === "string") {
      ops.push({ op: "edge.remove", id: raw.id });
    }
  }
  return ops;
}

const SYSTEM_PROMPT = `You are Jin, an architecture-oriented coding agent.
First classify the user's turn, then answer it in the same JSON object.

Classification:
- "chat": conversation, greetings, questions, explanations, brainstorming, status checks, or any request that does not need to change the repository, files, code, tests, commands, or architecture. For chat, write a complete, helpful reply in "message" and leave "tasks", "nodeIntents", and "ops" empty.
- "plan": the user asks you to add/remove/refactor code, fix a bug, change files, run commands, add tests, or change the architecture. Only plan turns may carry architecture operations.
- If a turn is ambiguous, use "chat" for a question or explanation and "plan" for an imperative change request.
- Pure chat must never create an Intent, architecture operations, or a review gate. Answer the user directly.

Planning rules (kind "plan" only):
- Every plan turn has an Intent. It may have zero ops (intent-only or touch-only), but it must have a clear goal.
- Prefer updating existing nodes by their exact ULID. Never invent an ULID.
- For a new node, use an id like "new:short-slug"; Jin will derive a stable id.
- Reuse an existing L1 before adding a duplicate. If the change is code-only, use zero ops and put the affected existing node(s) in nodeIntents.
- Keep changes small enough for one human approval. Do not redesign unrelated modules.
- L0 kinds: system, domain, module, layer, external. L1 kinds: component, hook, entity, service, repository, route, store, type, module, function, table, schema, config. Use module as the neutral L1 kind when a file does not clearly fit another role. Facets: method, field, property.
- node.add requires: level, kind, parentId, name, path, file, symbol, responsibility, status, metadata.
- node.update requires id and a patch containing only changed structural fields.
- node.remove requires id. Never remove the system node.
- Do not include beforeHash; Jin fills it from the approved snapshot.
- Return strict JSON only.

JSON shape for a chat turn:
{
  "kind": "chat",
  "message": "complete conversational reply"
}

JSON shape for a plan turn:
{
  "kind": "plan",
  "title": "short intent title",
  "goal": "one paragraph",
  "message": "what you want the user to review",
  "reuseQuery": "code/reuse search query",
  "tasks": [{"title": "...", "acceptance": ["..."]}],
  "nodeIntents": [{"nodeId": "ULID or new:slug", "facetId": "optional", "statement": "...", "invariants": [], "acceptance": []}],
  "ops": [
    {"op":"node.add","node":{"id":"new:slug","level":"L1","kind":"component","parentId":"ULID","name":"...","path":"src/...","file":"src/...","symbol":"","responsibility":"...","status":"planned","metadata":{}}},
    {"op":"node.update","id":"ULID","patch":{"responsibility":"..."}},
    {"op":"node.remove","id":"ULID"}
  ]
}`;

export async function planWithProvider(
  config: ProviderConfig,
  request: string,
  context: PlannerContext,
): Promise<PlanDraft> {
  const architecture = architectureSummary(
    context.snapshot,
    plannerContextBudget(config.contextWindow ?? 128_000, config.compactionRatio ?? 0.8),
  );
  const history = (context.history ?? [])
    .filter((message) => message.content.trim())
    .map(
      (message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content.trim()}`,
    )
    .join("\n\n");
  const user = [
    history ? `Recent conversation (oldest first):\n${history}` : "",
    `User request:\n${request}`,
    `Approved architecture (source of truth):\n${architecture}`,
    context.reuseSummary
      ? `Initial reuse retrieval (informational; verify in code):\n${context.reuseSummary}`
      : "",
    context.skills ? `Relevant skills:\n${context.skills}` : "",
    "Return the JSON object described in the system prompt.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const json = await completeJson(config, SYSTEM_PROMPT, user, {
    temperature: 0.2,
    maxTokens: 8000,
    json: true,
    signal: context.signal,
    onUsage: context.onUsage,
    onDelta: context.onDelta,
  });

  if (json.kind === "chat") {
    const message =
      stringValue(json.message).trim() ||
      stringValue(json.answer).trim() ||
      stringValue(json.reply).trim();
    if (!message) {
      throw new ProviderError("Chat response is missing a message");
    }
    return {
      kind: "chat",
      title: message.slice(0, 80),
      goal: request.slice(0, 4000),
      tasks: [],
      nodeIntents: [],
      ops: [],
      reuseQuery: "",
      assistantMessage: message,
    };
  }

  const title = stringValue(json.title).trim();
  const goal = stringValue(json.goal).trim();
  if (!title || !goal) {
    throw new ProviderError("Architect response is missing title or goal");
  }
  const ops = parseOps(json.ops);
  const nodeIntents = parseNodeIntents(json.nodeIntents);
  return {
    kind: "plan",
    title: title.slice(0, 160),
    goal: goal.slice(0, 4000),
    tasks: parseTasks(json.tasks),
    nodeIntents,
    ops,
    reuseQuery: stringValue(json.reuseQuery).trim() || request,
    assistantMessage:
      stringValue(json.message).trim() ||
      `Prepared ${ops.length} architecture operation${ops.length === 1 ? "" : "s"} for review. No code has been written yet.`,
  };
}

export { architectureSummary };
