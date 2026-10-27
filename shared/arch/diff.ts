import type { ArchEdge, ArchNode } from "./types";

export type ChangeKind = "added" | "removed" | "modified";

/**
 * One semantic node change. `before`/`after` are the reviewed snapshots, not
 * the live snapshot, so the UI can render a proposal even after local edits.
 */
export interface NodeChange {
  id: string;
  change: ChangeKind;
  before: ArchNode | null;
  after: ArchNode | null;
  /** Semantic fields that differ; empty for added/removed nodes. */
  fields: string[];
  /** True when the color was propagated from a child or an edge. */
  propagated: boolean;
}

export interface EdgeChange {
  id: string;
  change: ChangeKind;
  before: ArchEdge | null;
  after: ArchEdge | null;
  fields: string[];
}

export interface ArchDiffSummary {
  added: number;
  removed: number;
  modified: number;
  /** Number of nodes that carry a diff color, including propagated L0s. */
  affected: number;
}

export interface ArchDiff {
  nodes: Record<string, NodeChange>;
  edges: Record<string, EdgeChange>;
  /**
   * Diff color for every affected node, including ancestors. A parent with a
   * modified child is yellow; a newly added parent stays green.
   */
  colors: Record<string, ChangeKind>;
  summary: ArchDiffSummary;
}

export type RiskLevel = "low" | "medium" | "high";

export interface RiskHint {
  id: string;
  level: RiskLevel;
  title: string;
  detail: string;
  nodeId?: string;
}
