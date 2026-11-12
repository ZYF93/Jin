import type {
  ArchEdgeDraft,
  ArchNode,
  ArchOp,
  ArchNodeDraft,
  L0Kind,
  L1Kind,
  NodeIntent,
  NodeStatus,
} from "../../../shared/ledger/types";

export type NodePatch = Partial<
  Pick<
    ArchNode,
    | "level"
    | "kind"
    | "parentId"
    | "name"
    | "path"
    | "file"
    | "symbol"
    | "responsibility"
    | "intentId"
    | "status"
    | "metadata"
  >
>;

export interface PlannedNodeAdd {
  op: "node.add";
  node: {
    id?: string;
    level: ArchNodeDraft["level"];
    kind: ArchNodeDraft["kind"];
    parentId: string | null;
    name: string;
    path: string;
    file: string;
    symbol: string;
    responsibility: string;
    intentId?: string | null;
    status?: NodeStatus;
    metadata?: Record<string, unknown>;
  };
}

export interface PlannedNodeUpdate {
  op: "node.update";
  id: string;
  patch: NodePatch;
}

export interface PlannedNodeRemove {
  op: "node.remove";
  id: string;
}

export interface PlannedEdgeAdd {
  op: "edge.add";
  edge: ArchEdgeDraft;
}

export interface PlannedEdgeRemove {
  op: "edge.remove";
  id: string;
}

export type PlannedOp =
  | PlannedNodeAdd
  | PlannedNodeUpdate
  | PlannedNodeRemove
  | PlannedEdgeAdd
  | PlannedEdgeRemove;

export interface PlannedTask {
  title: string;
  acceptance: string[];
  files?: string[];
  dependsOn?: string[];
}

export interface PlannedNodeIntent {
  nodeId: string;
  facetId?: string;
  statement: string;
  invariants?: string[];
  acceptance?: string[];
}

/** A turn is either a direct conversational reply or an architecture proposal. */
export type PlanKind = "chat" | "plan";

export interface PlanDraft {
  kind: PlanKind;
  title: string;
  goal: string;
  tasks: PlannedTask[];
  nodeIntents: PlannedNodeIntent[];
  ops: PlannedOp[];
  reuseQuery: string;
  assistantMessage: string;
}

export interface NormalizedPlan {
  ops: ArchOp[];
  nodeIntents: NodeIntent[];
  warnings: string[];
}

export interface PlannerHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PlannerContext {
  snapshot: import("../../../shared/ledger/types").ArchSnapshot;
  skills: string;
  reuseSummary: string;
  /** Recent conversational turns, oldest first, for follow-up continuity. */
  history?: readonly PlannerHistoryMessage[];
  onUsage?: (usage: import("./provider").ProviderTokenUsage) => void;
  /** Raw JSON deltas from the planner stream. */
  onDelta?: (delta: string) => void;
  /** Model thinking/reasoning deltas from the planner stream. */
  onReasoning?: (delta: string) => void;
  /** AGENTS.md rules (project + global), injected into the planning prompt. */
  rules?: string;
  signal?: AbortSignal;
}

export interface PlannerConfig {
  model: import("../../../shared/ipc").ProviderSettings;
  apiKey: string | null;
  temperature: number;
  maxTokens: number;
}

export type { L0Kind, L1Kind };
