import type {
  ArchNode,
  ArchSnapshot,
  L1Kind,
  NodeKind,
} from "../../../shared/arch/types";
import { stableIds } from "../ids/stable";
import type {
  PlannedNodeAdd,
  PlannedOp,
  PlanDraft,
} from "./plan-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pascal(value: string): string {
  const pieces = value
    .replace(/[^A-Za-z0-9\u3400-\u9fff]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const result = pieces
    .map((piece) => `${piece.charAt(0).toUpperCase()}${piece.slice(1)}`)
    .join("");
  return result || "NewUnit";
}

function slug(value: string): string {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return result || "new-unit";
}

function nodeText(node: ArchNode): string {
  return `${node.name} ${node.path} ${node.file} ${node.symbol} ${node.responsibility}`.toLowerCase();
}

function findNode(snapshot: ArchSnapshot, query: string): ArchNode | null {
  const clean = query.trim().toLowerCase();
  if (!clean) return null;
  const nodes = Object.values(snapshot.nodes);
  return (
    nodes.find((node) => node.id === query) ??
    nodes.find((node) => node.name.toLowerCase() === clean) ??
    nodes.find((node) => node.path.toLowerCase() === clean) ??
    nodes.find((node) => node.file.toLowerCase() === clean) ??
    nodes.find((node) => nodeText(node).includes(clean)) ??
    null
  );
}

function extractQuoted(text: string): string | null {
  const match = text.match(/["“'`]([^"”'`]{1,80})["”'`]/);
  return match?.[1]?.trim() ?? null;
}

function extractName(text: string): string {
  const quoted = extractQuoted(text);
  if (quoted) return quoted;
  const chinese = text.match(
    /(?:组件|模块|服务|页面|路由|领域|hook|store|component|module|service|page|route|domain)\s*(?:名为|叫|[:：])?\s*([A-Za-z0-9_\u3400-\u9fff-]{2,40})/i,
  );
  if (chinese?.[1]) return chinese[1];
  const english = text.match(
    /(?:add|create|new)\s+(?:a|an|the\s+)?(?:[a-z]+\s+)?([A-Za-z_$][\w$-]{1,40})/i,
  );
  if (english?.[1]) return english[1];
  const words = text.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.slice(0, 40) || "NewUnit";
}

function detectKind(text: string): { level: "L0" | "L1"; kind: NodeKind } {
  const lower = text.toLowerCase();
  if (/(module|模块|领域|domain)/i.test(text)) return { level: "L0", kind: "module" };
  if (/hook/i.test(lower)) return { level: "L1", kind: "hook" };
  if (/(service|服务)/i.test(text)) return { level: "L1", kind: "service" };
  if (/(store|状态)/i.test(text)) return { level: "L1", kind: "store" };
  if (/(page|页面|route|路由)/i.test(text)) return { level: "L1", kind: "route" };
  if (/(repository|repo|仓储)/i.test(text)) return { level: "L1", kind: "repository" };
  if (/(entity|实体|model)/i.test(text)) return { level: "L1", kind: "entity" };
  if (/(type|类型)/i.test(text)) return { level: "L1", kind: "type" };
  return { level: "L1", kind: "component" };
}

function bestParent(snapshot: ArchSnapshot, text: string): ArchNode | null {
  const system =
    Object.values(snapshot.nodes).find(
      (node) => node.level === "L0" && node.kind === "system",
    ) ?? null;
  const candidates = Object.values(snapshot.nodes).filter(
    (node) =>
      node.level === "L0" &&
      node.kind !== "system" &&
      node.kind !== "external",
  );
  const lower = text.toLowerCase();
  const scored = candidates
    .map((node) => {
      let score = 0;
      if (lower.includes(node.name.toLowerCase())) score += 5;
      if (node.path && lower.includes(node.path.toLowerCase())) score += 4;
      if (/(ui|component|组件|feature|页面|chat|聊天)/i.test(lower)) {
        if (/(ui|components?|features?|pages?)/i.test(node.path)) score += 3;
      }
      score += Math.min(3, node.path.split("/").length);
      return { node, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.node ?? system;
}

function suggestedFile(parent: ArchNode | null, name: string, kind: NodeKind): string {
  const className = pascal(name);
  const base = parent?.path || "src";
  if (kind === "component" || kind === "route") {
    return `${base}/${className}.tsx`;
  }
  if (kind === "hook") {
    return `${base}/use${className}.ts`;
  }
  if (kind === "store") {
    return `${base}/${className}.store.ts`;
  }
  if (kind === "service" || kind === "repository") {
    return `${base}/${className}.service.ts`;
  }
  return `${base}/${slug(name)}.ts`;
}

function addNode(
  snapshot: ArchSnapshot,
  text: string,
  name: string,
  level: "L0" | "L1",
  kind: NodeKind,
): PlannedOp[] {
  const system =
    Object.values(snapshot.nodes).find(
      (node) => node.level === "L0" && node.kind === "system",
    ) ?? null;
  const parent = level === "L0" ? system : bestParent(snapshot, text);
  const path =
    level === "L0"
      ? `src/${slug(name)}`
      : suggestedFile(parent, name, kind);
  const id =
    level === "L0"
      ? stableIds.node("module", path)
      : stableIds.node("file", path);
  if (snapshot.nodes[id]) {
    return [
      {
        op: "node.update",
        id,
        patch: {
          responsibility: text,
          status: "active",
        },
      },
    ];
  }
  const node: PlannedNodeAdd["node"] = {
    id,
    level,
    kind,
    parentId: level === "L0" ? system?.id ?? null : parent?.id ?? system?.id ?? null,
    name,
    path,
    file: level === "L0" ? "" : path,
    symbol: "",
    responsibility: text.slice(0, 500),
    intentId: null,
    status: "planned",
    metadata: { origin: "agent", planned: true, localPlanner: true },
  };
  const ops: PlannedOp[] = [{ op: "node.add", node }];
  if (node.parentId) {
    ops.push({
      op: "edge.add",
      edge: {
        id: stableIds.edge(node.parentId, "contains", id),
        from: node.parentId,
        to: id,
        kind: "contains",
        metadata: { origin: "agent" },
      },
    });
  }
  return ops;
}

function planIntentOnly(snapshot: ArchSnapshot, text: string, reason: string): PlanDraft {
  const target =
    findNode(snapshot, extractQuoted(text) ?? "") ??
    findNode(snapshot, text.split(/\s+/).slice(0, 4).join(" "));
  return {
    title: text.slice(0, 80) || "Intent-only turn",
    goal: text,
    tasks: [
      {
        title: "Clarify the requested change and implement it within the approved architecture",
        acceptance: ["The result matches the goal and does not silently change architecture"],
      },
    ],
    nodeIntents: target
      ? [
          {
            nodeId: target.id,
            statement: text.slice(0, 500),
            invariants: [],
            acceptance: [],
          },
        ]
      : [],
    ops: [],
    reuseQuery: text,
    assistantMessage:
      reason ||
      "I prepared an intent-only version. No structural change is proposed, so this review is cheap; approve it to continue and I will use the existing architecture.",
  };
}

/**
 * Deterministic planner used when no AI provider is configured, and as a
 * fallback when the provider returns unusable JSON. It only handles simple,
 * explicit structural verbs; everything else becomes an intent-only version
 * rather than pretending an LLM wrote a plan.
 */
export function localPlan(snapshot: ArchSnapshot, request: string): PlanDraft {
  const text = request.trim();
  const lower = text.toLowerCase();
  const quoted = extractQuoted(text);

  if (/(?:删除|移除|remove|delete|deprecate)/i.test(text)) {
    const target = findNode(snapshot, quoted ?? text);
    if (target) {
      return {
        title: `Remove ${target.name}`,
        goal: text,
        tasks: [
          {
            title: `Remove ${target.name} and its containment edges`,
            acceptance: ["No approved node or edge references the removed unit"],
          },
        ],
        nodeIntents: [],
        ops: [{ op: "node.remove", id: target.id }],
        reuseQuery: text,
        assistantMessage: `Prepared a removal proposal for ${target.name}. Review its children and dependents before approving.`,
      };
    }
  }

  if (/(?:重命名|改名|rename)/i.test(text)) {
    const match = text.match(
      /(?:重命名|改名|rename)\s+["“']?([\w\u3400-\u9fff .:/-]+?)["”']?\s*(?:为|to|=>)\s*["“']?([\w\u3400-\u9fff .:/-]+?)["”']?\s*$/i,
    );
    if (match?.[1] && match[2]) {
      const target = findNode(snapshot, match[1].trim());
      if (target) {
        return {
          title: `Rename ${target.name}`,
          goal: text,
          tasks: [
            {
              title: `Rename ${target.name} to ${match[2].trim()}`,
              acceptance: ["The node keeps its stable id and the responsibility is updated"],
            },
          ],
          nodeIntents: [],
          ops: [
            {
              op: "node.update",
              id: target.id,
              patch: { name: match[2].trim() },
            },
          ],
          reuseQuery: text,
          assistantMessage: `Prepared a rename of ${target.name} to ${match[2].trim()}.`,
        };
      }
    }
  }

  if (/(?:责任|职责|responsibility)/i.test(text)) {
    const target = findNode(snapshot, quoted ?? text);
    const statement = text.replace(/^.*?(?:责任|职责|responsibility)\s*(?:改为|to|[:：])?\s*/i, "").trim();
    if (target && statement) {
      return {
        title: `Update responsibility for ${target.name}`,
        goal: text,
        tasks: [
          {
            title: `Refine the responsibility of ${target.name}`,
            acceptance: ["The new responsibility is specific enough to verify"],
          },
        ],
        nodeIntents: [
          {
            nodeId: target.id,
            statement,
            invariants: [],
            acceptance: [],
          },
        ],
        ops: [
          {
            op: "node.update",
            id: target.id,
            patch: { responsibility: statement.slice(0, 500) },
          },
        ],
        reuseQuery: text,
        assistantMessage: `Prepared a responsibility update for ${target.name}.`,
      };
    }
  }

  const wantsAdd = /(?:新增|添加|创建|新建|add|create|new)/i.test(text);
  if (wantsAdd) {
    const detected = detectKind(text);
    const name = extractName(text);
    const ops = addNode(snapshot, text, name, detected.level, detected.kind);
    const firstAdd = ops.find(
      (op): op is PlannedNodeAdd => op.op === "node.add",
    );
    return {
      title: `${detected.level === "L0" ? "Add module" : "Add L1 unit"} ${name}`,
      goal: text,
      tasks: [
        {
          title: `Add and implement ${name} without duplicating an existing unit`,
          acceptance: [
            "The new unit has one clear responsibility",
            "The ReusePlan was considered before writing code",
          ],
        },
      ],
      nodeIntents: firstAdd
        ? [
            {
              nodeId: firstAdd.node.id ?? "",
              statement: text.slice(0, 500),
              invariants: [],
              acceptance: [],
            },
          ]
        : [],
      ops,
      reuseQuery: text,
      assistantMessage: `Prepared a ${detected.level} ${String(detected.kind)} proposal for ${name}. The diff is shown before any code is written.`,
    };
  }

  const fallback = planIntentOnly(
    snapshot,
    text,
    lower.includes("why") || text.includes("为什么")
      ? "I prepared an intent-only version to capture the question. Answering it does not require an architecture change."
      : "I could not infer a safe structural operation from this request. I prepared an intent-only version; use a more explicit verb (add, remove, rename, responsibility) or configure an AI provider for a semantic plan.",
  );
  return fallback;
}

export function planLooksValid(value: unknown): value is PlanDraft {
  return isRecord(value) && typeof value.title === "string" && Array.isArray(value.ops);
}

// Keep these imports referenced for the public type surface used by callers.
export type { L1Kind };
