import type {
  ArchNode,
  ArchSnapshot,
  L1Kind,
  NodeKind,
} from "../../../shared/arch/types";
import { translate, type MessageKey, type TranslationParams } from "../../../shared/i18n";
import { stableIds } from "../ids/stable";
import type {
  PlannedNodeAdd,
  PlannedOp,
  PlanDraft,
} from "./plan-types";

type Translator = (
  key: MessageKey,
  params?: TranslationParams,
) => string;

const english: Translator = (key, params) => translate("en", key, params);

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

function planIntentOnly(
  snapshot: ArchSnapshot,
  text: string,
  reason: string,
  t: Translator,
): PlanDraft {
  const target =
    findNode(snapshot, extractQuoted(text) ?? "") ??
    findNode(snapshot, text.split(/\s+/).slice(0, 4).join(" "));
  return {
    kind: "plan",
    title: text.slice(0, 80) || t("localPlan.intentOnlyTitle"),
    goal: text,
    tasks: [
      {
        title: t("localPlan.intentOnlyTask"),
        acceptance: [t("localPlan.intentOnlyAcceptance")],
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
    assistantMessage: reason || t("localPlan.intentOnlyGeneric"),
  };
}

/**
 * Deterministic planner used when no AI provider is configured, and as a
 * fallback when the provider returns unusable JSON. It only handles simple,
 * explicit structural verbs; everything else becomes an intent-only version
 * rather than pretending an LLM wrote a plan.
 */
export function localPlan(
  snapshot: ArchSnapshot,
  request: string,
  t: Translator = english,
): PlanDraft {
  const text = request.trim();
  const lower = text.toLowerCase();
  const quoted = extractQuoted(text);

  if (/(?:删除|移除|remove|delete|deprecate)/i.test(text)) {
    const target = findNode(snapshot, quoted ?? text);
    if (target) {
      return {
        kind: "plan",
        title: t("localPlan.removeTitle", { name: target.name }),
        goal: text,
        tasks: [
          {
            title: t("localPlan.removeTask", { name: target.name }),
            acceptance: [t("localPlan.removeAcceptance")],
          },
        ],
        nodeIntents: [],
        ops: [{ op: "node.remove", id: target.id }],
        reuseQuery: text,
        assistantMessage: t("localPlan.removeMessage", { name: target.name }),
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
        const nextName = match[2].trim();
        return {
          kind: "plan",
          title: t("localPlan.renameTitle", { name: target.name }),
          goal: text,
          tasks: [
            {
              title: t("localPlan.renameTask", {
                name: target.name,
                to: nextName,
              }),
              acceptance: [t("localPlan.renameAcceptance")],
            },
          ],
          nodeIntents: [],
          ops: [
            {
              op: "node.update",
              id: target.id,
              patch: { name: nextName },
            },
          ],
          reuseQuery: text,
          assistantMessage: t("localPlan.renameMessage", {
            name: target.name,
            to: nextName,
          }),
        };
      }
    }
  }

  if (/(?:责任|职责|responsibility)/i.test(text)) {
    const target = findNode(snapshot, quoted ?? text);
    const statement = text.replace(/^.*?(?:责任|职责|responsibility)\s*(?:改为|to|[:：])?\s*/i, "").trim();
    if (target && statement) {
      return {
        kind: "plan",
        title: t("localPlan.responsibilityTitle", { name: target.name }),
        goal: text,
        tasks: [
          {
            title: t("localPlan.responsibilityTask", { name: target.name }),
            acceptance: [t("localPlan.responsibilityAcceptance")],
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
        assistantMessage: t("localPlan.responsibilityMessage", {
          name: target.name,
        }),
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
    const kind = t(`kind.${detected.kind}` as MessageKey);
    return {
      kind: "plan",
      title: t(
        detected.level === "L0" ? "localPlan.addModuleTitle" : "localPlan.addUnitTitle",
        { name },
      ),
      goal: text,
      tasks: [
        {
          title: t("localPlan.addTask", { name }),
          acceptance: [
            t("localPlan.addAcceptanceResponsibility"),
            t("localPlan.addAcceptanceReuse"),
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
      assistantMessage:
        detected.level === "L0"
          ? t("localPlan.addModuleMessage", { name })
          : t("localPlan.addUnitMessage", { name, kind }),
    };
  }

  const fallback = planIntentOnly(
    snapshot,
    text,
    lower.includes("why") || text.includes("为什么")
      ? t("localPlan.intentOnlyQuestion")
      : t("localPlan.intentOnlyUnsafe"),
    t,
  );
  return fallback;
}

export function planLooksValid(value: unknown): value is PlanDraft {
  return isRecord(value) && typeof value.title === "string" && Array.isArray(value.ops);
}

// Keep these imports referenced for the public type surface used by callers.
export type { L1Kind };
