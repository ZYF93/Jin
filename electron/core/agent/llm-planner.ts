import type {
  ArchSnapshot,
  L0Kind,
  L1Kind,
  NodeKind,
  NodeStatus,
} from "../../../shared/arch/types";
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

function architectureSummary(snapshot: ArchSnapshot): string {
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
  const maxL1 = 220;
  const maxFacets = 80;
  return [
    `System: ${l0.filter((node) => node.kind === "system").map((node) => node.name).join(", ")}`,
    "L0:",
    ...l0.map(line),
    `L1 (${l1.length}, showing ${Math.min(l1.length, maxL1)}):`,
    ...l1.slice(0, maxL1).map(line),
    `Facets (${facets.length}, showing ${Math.min(facets.length, maxFacets)}):`,
    ...facets.slice(0, maxFacets).map(line),
    l1.length > maxL1
      ? `… ${l1.length - maxL1} more L1 nodes. Prefer existing IDs from the visible list; ask for a file search instead of inventing IDs.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
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
            typeof node.parentId === "string" && node.parentId.trim()
              ? node.parentId.trim()
              : null,
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
            kind: stringValue(edge.kind) as import("../../../shared/arch/types").EdgeKind,
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

const SYSTEM_PROMPT = `You are Jin's architect. Jin is an architecture-oriented coding agent.
Your job is to translate one user turn into one Intent and a small set of architecture operations.
You are NOT writing code in this step, and you never approve anything.

Rules:
- Every turn has an Intent. It may have zero ops (intent-only or touch-only), but it must have a clear goal.
- Prefer updating existing nodes by their exact ULID. Never invent an ULID.
- For a new node, use an id like "new:short-slug"; Jin will derive a stable id.
- Reuse an existing L1 before adding a duplicate. If the change is code-only, use zero ops and put the affected existing node(s) in nodeIntents.
- Keep changes small enough for one human approval. Do not redesign unrelated modules.
- L0 kinds: system, domain, module, layer, external. L1 kinds: component, hook, entity, service, repository, route, store, type, function, table, schema, config. Facets: method, field, property.
- node.add requires: level, kind, parentId, name, path, file, symbol, responsibility, status, metadata.
- node.update requires id and a patch containing only changed structural fields.
- node.remove requires id. Never remove the system node.
- Do not include beforeHash; Jin fills it from the approved snapshot.
- Return strict JSON only.

JSON shape:
{
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
  const architecture = architectureSummary(context.snapshot);
  const user = [
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
  });

  const title = stringValue(json.title).trim();
  const goal = stringValue(json.goal).trim();
  if (!title || !goal) {
    throw new ProviderError("Architect response is missing title or goal");
  }
  const ops = parseOps(json.ops);
  const nodeIntents = parseNodeIntents(json.nodeIntents);
  return {
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
