/**
 * Architecture model shared by the Electron main process and the renderer.
 *
 * The model is intentionally boring: nodes are stable identities, files and
 * symbols are attributes, and every change is expressed as an op. The current
 * snapshot is a fold of approved WAL records, never the source of truth.
 */

export type ActorKind = "user" | "agent" | "system";

export interface Actor {
  id: string;
  kind: ActorKind;
  name: string;
  email?: string;
}

export type NodeLevel = "L0" | "L1" | "facet";

export type L0Kind = "system" | "domain" | "module" | "layer" | "external";
export type L1Kind =
  | "component"
  | "hook"
  | "entity"
  | "service"
  | "repository"
  | "route"
  | "store"
  | "type"
  | "module"
  | "function"
  | "table"
  | "schema"
  | "config";
export type FacetKind = "method" | "field" | "property";

export type NodeKind = L0Kind | L1Kind | FacetKind;

export type NodeStatus = "active" | "planned" | "deprecated";

export interface ArchNode {
  /** Stable identity. Never derive this from a file path. */
  id: string;
  level: NodeLevel;
  kind: NodeKind;
  parentId: string | null;
  name: string;
  /** Module path, e.g. `src/features/chat`. */
  path: string;
  /** Source file, when the node maps to one. */
  file: string;
  /** LSP symbol, when the node maps to one. */
  symbol: string;
  responsibility: string;
  /** Current approved intent targeting this node/facet. */
  intentId: string | null;
  status: NodeStatus;
  metadata: Record<string, unknown>;
  /** Version that introduced this node. */
  introducedIn: string;
  /** Version that last changed a structural field. */
  updatedIn: string;
  /** Version that last touched code without changing structure. */
  lastTouchedIn: string | null;
}

/** A node before it is materialized into a snapshot. */
export type ArchNodeDraft = Omit<ArchNode, "introducedIn" | "updatedIn" | "lastTouchedIn">;

export type EdgeKind =
  | "contains"
  | "depends_on"
  | "uses"
  | "implements"
  | "extends"
  | "references"
  | "renders"
  | "reads"
  | "writes"
  | "constrains";

export interface ArchEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  metadata: Record<string, unknown>;
  introducedIn: string;
}

export type ArchEdgeDraft = Omit<ArchEdge, "introducedIn">;

export interface IntentTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  dependsOn: string[];
  acceptance: string[];
}

export interface NodeIntent {
  nodeId: string;
  /** Optional facet under an L1 node. */
  facetId?: string;
  statement: string;
  invariants: string[];
  acceptance: string[];
}

export interface Intent {
  id: string;
  versionId: string;
  title: string;
  goal: string;
  tasks: IntentTask[];
  nodeIntents: NodeIntent[];
  author: Actor;
  createdAt: string;
  /**
   * Scan syncs, imports and drift amendments change architecture only: their
   * approval never starts a code turn. Absent means "code" for old records.
   */
  mode?: "architecture" | "code";
  /**
   * Conflicted version ids reconciled by this merge intent. Once approved, the
   * original conflicts stay in the ledger but are no longer shown as open.
   */
  resolves?: string[];
}

export interface Touch {
  id: string;
  versionId: string;
  intentId: string;
  nodeId: string;
  facetId: string | null;
  reason: string;
  codeRefs: string[];
  tests: string[];
  actor: Actor;
  createdAt: string;
}

export type VersionStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "implemented"
  | "verified"
  | "rejected"
  | "superseded"
  | "conflicted";

export interface Decision {
  id: string;
  versionId: string;
  decision: "approved" | "rejected";
  by: Actor;
  note: string;
  /** Hash of the snapshot the reviewer saw, for audit. */
  baseHash: string;
  /** Hash of the snapshot after the reviewed ops, for audit. */
  targetHash: string;
  /**
   * Hash of the reviewed change set (ops + touches + node intents).
   * This is what approvals bind to, so disjoint concurrent versions can merge.
   */
  diffHash?: string;
  signature: string;
  createdAt: string;
}

export interface ImplementationCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface ConformanceResult {
  /** Op record id this result verifies, or the drift sentinel. */
  opId: string;
  /** Optional for records written before this field existed. */
  kind?: "op" | "drift";
  status: "pass" | "fail";
  evidence: string[];
}

export interface ImplementationRecord {
  id: string;
  versionId: string;
  gitCommit: string;
  files: string[];
  checks: ImplementationCheck[];
  conformance: ConformanceResult[];
  actor: Actor;
  createdAt: string;
}

export interface VersionState {
  id: string;
  intentId: string;
  status: VersionStatus;
  /** 1-based UI ordinal. ULID remains the real id. */
  ordinal: number | null;
  /** Record ids for ops in this version. */
  ops: string[];
  /** Record ids for touch records in this version. */
  touches: string[];
  /** Record ids for decisions about this version. */
  decisions: string[];
  /** Record ids for implementation records. */
  implementations: string[];
  baseHash: string | null;
  targetHash: string | null;
  diffHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ArchOp =
  | { op: "node.add"; node: ArchNodeDraft }
  | {
      op: "node.update";
      id: string;
      patch: Partial<
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
      beforeHash: string;
    }
  | { op: "node.remove"; id: string; beforeHash: string }
  | { op: "edge.add"; edge: ArchEdgeDraft }
  | { op: "edge.remove"; id: string; beforeHash: string };

export interface ArchSnapshot {
  schemaVersion: 1;
  nodes: Record<string, ArchNode>;
  edges: Record<string, ArchEdge>;
  intents: Record<string, Intent>;
  touches: Record<string, Touch>;
  versions: Record<string, VersionState>;
  decisions: Record<string, Decision>;
  implementations: Record<string, ImplementationRecord>;
  lastRecordId: string | null;
  recordCount: number;
}

export type WalConflictCode =
  | "duplicate-id"
  | "missing-parent"
  | "cycle"
  | "missing-intent"
  | "missing-node"
  | "missing-edge"
  | "stale-write"
  | "unknown-op"
  | "approval-mismatch"
  | "version-already-decided"
  | "invalid-version";

export interface WalConflict {
  code: WalConflictCode;
  message: string;
  recordIds: string[];
  nodeId?: string;
  /** Version whose application produced this conflict, when known. */
  versionId?: string;
}

export interface FoldResult {
  snapshot: ArchSnapshot;
  conflicts: WalConflict[];
  warnings: string[];
}
