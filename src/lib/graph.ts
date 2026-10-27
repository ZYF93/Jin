import dagre from "dagre";
import {
  MarkerType,
  Position,
  type Edge as FlowEdge,
  type Node as FlowNode,
} from "@xyflow/react";
import type { ChangeKind } from "../../shared/arch/diff";
import type { ArchEdge, ArchNode } from "../../shared/arch/types";
import type { ArchSnapshot, ProposalView } from "../../shared/ipc";
import { isReviewing } from "./utils";

export type ArchGraphNodeData = {
  node: ArchNode;
  change: ChangeKind | null;
  childCount: number;
  intentTitle: string | null;
  selected: boolean;
} & Record<string, unknown>;

export type ArchGraphNode = FlowNode<ArchGraphNodeData, "arch">;

export interface GraphModel {
  nodes: ArchGraphNode[];
  edges: FlowEdge[];
  signature: string;
  nodeCount: number;
  edgeCount: number;
  reviewing: boolean;
}

const WIDTH: Record<ArchNode["level"], number> = {
  L0: 232,
  L1: 210,
  facet: 178,
};

const HEIGHT: Record<ArchNode["level"], number> = {
  L0: 84,
  L1: 76,
  facet: 56,
};

const CHANGE_STROKE: Record<ChangeKind, string> = {
  added: "#34d399",
  removed: "#fb7185",
  modified: "#fbbf24",
};

function layout(
  nodes: ArchGraphNode[],
  hierarchy: Array<{ parent: string; child: string }>,
): ArchGraphNode[] {
  if (nodes.length === 0) return nodes;
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "TB",
    nodesep: 34,
    ranksep: 84,
    marginx: 36,
    marginy: 36,
    ranker: "network-simplex",
  });

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: WIDTH[node.data.node.level],
      height: HEIGHT[node.data.node.level],
    });
  }
  for (const pair of hierarchy) {
    if (graph.hasNode(pair.parent) && graph.hasNode(pair.child)) {
      graph.setEdge(pair.parent, pair.child);
    }
  }

  dagre.layout(graph);

  return nodes.map((node) => {
    const point = graph.node(node.id) as
      | { x: number; y: number; width?: number; height?: number }
      | undefined;
    if (!point) return node;
    const width = point.width ?? WIDTH[node.data.node.level];
    const height = point.height ?? HEIGHT[node.data.node.level];
    return {
      ...node,
      width,
      height,
      position: {
        x: point.x - width / 2,
        y: point.y - height / 2,
      },
    };
  });
}

function syntheticEdge(parent: ArchNode, child: ArchNode): ArchEdge {
  return {
    id: `ui-contains:${parent.id}:${child.id}`,
    from: parent.id,
    to: child.id,
    kind: "contains",
    metadata: { origin: "jin-ui" },
    introducedIn: child.introducedIn,
  };
}

/**
 * Build one visual model for both the approved graph and a proposal's graph
 * diff. Removed nodes/edges are pulled from the reviewed base snapshot so they
 * remain visible in red until the review is resolved.
 */
export function buildArchitectureGraph(
  snapshot: ArchSnapshot | null,
  proposal: ProposalView | null,
  expanded: boolean,
  selectedNodeId: string | null,
): GraphModel {
  if (!snapshot) {
    return {
      nodes: [],
      edges: [],
      signature: "empty",
      nodeCount: 0,
      edgeCount: 0,
      reviewing: false,
    };
  }

  const reviewing = isReviewing(proposal);
  const target = reviewing && proposal ? proposal.targetSnapshot : snapshot;
  const base = reviewing && proposal ? proposal.baseSnapshot : snapshot;
  const diff = reviewing && proposal ? proposal.diff : null;

  const candidate = new Map<string, { node: ArchNode; change: ChangeKind | null }>();
  for (const node of Object.values(target.nodes)) {
    candidate.set(node.id, { node, change: diff?.colors[node.id] ?? null });
  }
  if (diff) {
    for (const change of Object.values(diff.nodes)) {
      if (change.change === "removed" && change.before) {
        candidate.set(change.id, { node: change.before, change: "removed" });
      }
    }
    for (const color of Object.keys(diff.colors)) {
      if (candidate.has(color)) continue;
      const node = target.nodes[color] ?? base.nodes[color];
      if (node) candidate.set(color, { node, change: diff.colors[color] ?? null });
    }
  }

  const visible = new Map<string, { node: ArchNode; change: ChangeKind | null }>();
  for (const [id, entry] of candidate) {
    if (!expanded && entry.node.level !== "L0") continue;
    visible.set(id, entry);
  }

  const children = new Map<string, number>();
  for (const node of Object.values(target.nodes)) {
    if (!node.parentId) continue;
    children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
  }

  const flowNodes: ArchGraphNode[] = [...visible.values()].map(({ node, change }) => {
    const intent = node.intentId ? target.intents[node.intentId] : undefined;
    return {
      id: node.id,
      type: "arch",
      position: { x: 0, y: 0 },
      width: WIDTH[node.level],
      height: HEIGHT[node.level],
      data: {
        node,
        change,
        childCount: children.get(node.id) ?? 0,
        intentTitle: intent?.title ?? null,
        selected: selectedNodeId === node.id,
      },
      selected: selectedNodeId === node.id,
      draggable: true,
      connectable: false,
    };
  });

  const edgeSource = new Map<string, { edge: ArchEdge; change: ChangeKind | null }>();
  for (const edge of Object.values(target.edges)) {
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
    edgeSource.set(edge.id, { edge, change: diff?.edges[edge.id]?.change ?? null });
  }
  if (diff) {
    for (const change of Object.values(diff.edges)) {
      if (change.change !== "removed" || !change.before) continue;
      if (!visible.has(change.before.from) || !visible.has(change.before.to)) continue;
      edgeSource.set(change.id, { edge: change.before, change: "removed" });
    }
  }

  const hierarchy: Array<{ parent: string; child: string }> = [];
  const existingPairs = new Set(
    [...edgeSource.values()].map(({ edge }) => `${edge.from}\u0000${edge.to}`),
  );
  for (const node of visible.values()) {
    const parentId = node.node.parentId;
    if (!parentId || !visible.has(parentId)) continue;
    hierarchy.push({ parent: parentId, child: node.node.id });
    if (existingPairs.has(`${parentId}\u0000${node.node.id}`)) continue;
    const parent = visible.get(parentId)?.node;
    if (!parent) continue;
    const edge = syntheticEdge(parent, node.node);
    edgeSource.set(edge.id, { edge, change: null });
  }

  const flowEdges: FlowEdge[] = [...edgeSource.values()].map(({ edge, change }) => {
    const isContains = edge.kind === "contains" || edge.metadata.origin === "jin-ui";
    const stroke = change ? CHANGE_STROKE[change] : isContains ? "#94a3b8" : "#64748b";
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: isContains ? "smoothstep" : "default",
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      animated: change === "added" && !isContains,
      zIndex: change ? 3 : 1,
      style: {
        stroke,
        strokeWidth: change ? 1.6 : isContains ? 0.8 : 1.05,
        strokeOpacity: isContains ? 0.28 : change ? 0.92 : 0.45,
        strokeDasharray: isContains ? "4 5" : undefined,
      },
      markerEnd:
        isContains || edge.kind === "contains"
          ? undefined
          : {
              type: MarkerType.ArrowClosed,
              width: 10,
              height: 10,
              color: stroke,
            },
    };
  });

  const sorted = flowNodes.sort((a, b) => {
    const rank = { L0: 0, L1: 1, facet: 2 };
    const level = rank[a.data.node.level] - rank[b.data.node.level];
    if (level !== 0) return level;
    return a.data.node.path.localeCompare(b.data.node.path);
  });
  const laidOut = layout(sorted, hierarchy);

  const signature = [
    reviewing ? proposal?.id ?? "review" : "live",
    expanded ? "expanded" : "collapsed",
    proposal?.ops.length ?? 0,
    target.recordCount,
    visible.size,
    edgeSource.size,
  ].join(":");

  return {
    nodes: laidOut,
    edges: flowEdges,
    signature,
    nodeCount: laidOut.length,
    edgeCount: flowEdges.length,
    reviewing,
  };
}
