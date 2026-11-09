import { MarkerType, Position, type Edge as FlowEdge, type Node as FlowNode } from "@xyflow/react";
import type { ArchDiff, ChangeKind } from "../../shared/arch/diff";
import type { ArchEdge, ArchNode } from "../../shared/ledger/types";
import type { ArchSnapshot, ProposalView } from "../../shared/ipc";
import { isReviewing } from "./utils";

export type ArchGraphNodeData = {
  node: ArchNode;
  change: ChangeKind | null;
  /** L1 units directly below an L0 module, or facts below an L1 unit. */
  childCount: number;
  /** Direct L0 modules below an L0 layer, domain, or system. */
  moduleCount: number;
  /** Direct facet changes rolled up into an L1 card. */
  factChanges: { added: number; removed: number; modified: number };
  intentTitle: string | null;
  selected: boolean;
  expanded: boolean;
  expandable: boolean;
  /** Rendered as a labelled block that contains its children. */
  region: boolean;
} & Record<string, unknown>;

export type ArchGraphNode = FlowNode<ArchGraphNodeData, "arch">;

export interface GraphModel {
  nodes: ArchGraphNode[];
  edges: FlowEdge[];
  signature: string;
  /** Stable while expanding/collapsing, so the viewport is not reset. */
  layoutKey: string;
  nodeCount: number;
  edgeCount: number;
  reviewing: boolean;
  mode: "live" | "proposal" | "replay";
  /** Node whose direct relations are isolated, when focus mode is active. */
  focus: string | null;
}

/**
 * Read-only view of one historical version, reconstructed by the main process.
 * The canvas draws its graph diff in place instead of opening a modal.
 */
export interface GraphReplay {
  id: string;
  baseSnapshot: ArchSnapshot;
  targetSnapshot: ArchSnapshot;
  diff: ArchDiff;
}

export type ExpandedL0 = Record<string, true>;

const LEAF_WIDTH: Record<"L0" | "L1", number> = {
  L0: 220,
  L1: 208,
};

const LEAF_HEIGHT: Record<"L0" | "L1", number> = {
  L0: 84,
  L1: 78,
};

/** L0 nodes with children are blocks: a solid header plus a dashed region. */
const REGION_HEADER = 64;
const REGION_MIN_WIDTH = 258;
const REGION_PAD_X = 16;
const REGION_PAD_TOP = 10;
const REGION_PAD_BOTTOM = 16;
const CONTENT_GAP_X = 18;
const CONTENT_GAP_Y = 20;
const MAX_CONTENT_WIDTH = 980;
const ROOT_MAX_WIDTH = 1800;

const CHANGE_STROKE: Record<ChangeKind, string> = {
  added: "#34d399",
  removed: "#fb7185",
  modified: "#fbbf24",
};

const LEVEL_RANK: Record<ArchNode["level"], number> = {
  L0: 0,
  L1: 1,
  facet: 2,
};

const KIND_RANK: Record<string, number> = {
  system: 0,
  layer: 1,
  module: 2,
  domain: 3,
  external: 4,
};

interface LayoutBox {
  id: string;
  node: ArchNode;
  width: number;
  height: number;
  /** Top-left, relative to the parent block's top-left. */
  x: number;
  y: number;
  region: boolean;
  children: LayoutBox[];
}

interface PackedRow {
  boxes: LayoutBox[];
  width: number;
  height: number;
}

function packRows(boxes: LayoutBox[], maxWidth: number): PackedRow[] {
  if (boxes.length === 0) return [];
  const rows: PackedRow[] = [];
  let row: LayoutBox[] = [];
  let width = 0;
  let height = 0;
  const flush = (): void => {
    if (row.length === 0) return;
    rows.push({ boxes: row, width, height });
    row = [];
    width = 0;
    height = 0;
  };
  for (const box of boxes) {
    const nextWidth = row.length === 0 ? box.width : width + CONTENT_GAP_X + box.width;
    if (row.length > 0 && nextWidth > maxWidth) flush();
    width = row.length === 0 ? box.width : width + CONTENT_GAP_X + box.width;
    height = Math.max(height, box.height);
    row.push(box);
  }
  flush();
  return rows;
}

function compareNodes(left: ArchNode, right: ArchNode): number {
  const level = LEVEL_RANK[left.level] - LEVEL_RANK[right.level];
  if (level !== 0) return level;
  const kind = (KIND_RANK[left.kind] ?? 5) - (KIND_RANK[right.kind] ?? 5);
  if (kind !== 0) return kind;
  return (left.path || left.name).localeCompare(right.path || right.name);
}

/**
 * Recursive region layout. Every L0 node is a block. A block with children
 * reserves a header and wraps those children into rows inside its dashed body;
 * a block without children is a compact card. Layers, domains, and systems are
 * therefore visible regions rather than peer nodes, and expanding a module
 * grows its own block instead of scaling the whole graph down.
 */
function layoutRegions(
  visible: Map<string, { node: ArchNode; change: ChangeKind | null }>,
  parentById: Map<string, string | null>,
): Map<string, LayoutBox> {
  const childrenByParent = new Map<string, string[]>();
  for (const [id, parentId] of parentById) {
    if (!parentId) continue;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(id);
    childrenByParent.set(parentId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((left, right) => {
      const a = visible.get(left)?.node;
      const b = visible.get(right)?.node;
      return a && b ? compareNodes(a, b) : left.localeCompare(right);
    });
  }

  const measured = new Map<string, LayoutBox>();

  const measure = (id: string): LayoutBox => {
    const entry = visible.get(id);
    if (!entry) {
      return {
        id,
        node: {} as ArchNode,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        region: false,
        children: [],
      };
    }
    const node = entry.node;
    const childIds = childrenByParent.get(id) ?? [];
    const children = childIds.map(measure);
    if (children.length === 0) {
      const level = node.level === "L1" ? "L1" : "L0";
      return {
        id,
        node,
        width: LEAF_WIDTH[level],
        height: LEAF_HEIGHT[level],
        x: 0,
        y: 0,
        region: false,
        children: [],
      };
    }

    const rows = packRows(children, MAX_CONTENT_WIDTH);
    const contentWidth = rows.reduce((max, row) => Math.max(max, row.width), 0);
    const contentHeight =
      rows.reduce((sum, row) => sum + row.height, 0) + Math.max(0, rows.length - 1) * CONTENT_GAP_Y;
    const width = Math.max(REGION_MIN_WIDTH, contentWidth + REGION_PAD_X * 2);
    const height = REGION_HEADER + REGION_PAD_TOP + contentHeight + REGION_PAD_BOTTOM;
    let rowTop = REGION_HEADER + REGION_PAD_TOP;
    for (const row of rows) {
      let cursor = (width - row.width) / 2;
      for (const child of row.boxes) {
        child.x = cursor;
        child.y = rowTop;
        cursor += child.width + CONTENT_GAP_X;
      }
      rowTop += row.height + CONTENT_GAP_Y;
    }
    return {
      id,
      node,
      width,
      height,
      x: 0,
      y: 0,
      region: true,
      children,
    };
  };

  const roots = [...visible.keys()]
    .filter((id) => !parentById.get(id))
    .map((id) => measure(id))
    .sort((left, right) => compareNodes(left.node, right.node));
  const rootRows = packRows(roots, ROOT_MAX_WIDTH);
  let rowTop = 0;
  for (const row of rootRows) {
    let cursor = 0;
    for (const box of row.boxes) {
      box.x = cursor;
      box.y = rowTop;
      cursor += box.width + CONTENT_GAP_X;
    }
    rowTop += row.height + CONTENT_GAP_Y;
  }
  for (const root of roots) measured.set(root.id, root);
  const remember = (box: LayoutBox): void => {
    measured.set(box.id, box);
    for (const child of box.children) remember(child);
  };
  for (const root of roots) remember(root);
  return measured;
}

function directChildren(snapshot: ArchSnapshot, id: string, level: ArchNode["level"]): ArchNode[] {
  return Object.values(snapshot.nodes).filter(
    (node) => node.parentId === id && node.level === level,
  );
}

/**
 * Build one visual model for the live graph, a proposal diff, or a historical
 * replay. L0 is always visible; an L0 expands to its L1 units. Facets are never
 * graph nodes: methods, fields, and properties are facts on the L1 inspector.
 */
export function buildArchitectureGraph(
  snapshot: ArchSnapshot | null,
  proposal: ProposalView | null,
  expandedL0: ExpandedL0,
  selectedNodeId: string | null,
  replay: GraphReplay | null = null,
  focusNodeId: string | null = null,
): GraphModel {
  const empty = (): GraphModel => ({
    nodes: [],
    edges: [],
    signature: "empty",
    layoutKey: "empty",
    nodeCount: 0,
    edgeCount: 0,
    reviewing: false,
    mode: "live",
    focus: null,
  });
  if (!snapshot && !replay) return empty();

  let mode: GraphModel["mode"];
  let target: ArchSnapshot;
  let base: ArchSnapshot;
  let diff: ArchDiff | null;
  if (replay) {
    mode = "replay";
    target = replay.targetSnapshot;
    base = replay.baseSnapshot;
    diff = replay.diff;
  } else if (snapshot && isReviewing(proposal) && proposal) {
    mode = "proposal";
    target = proposal.targetSnapshot;
    base = proposal.baseSnapshot;
    diff = proposal.diff;
  } else if (snapshot) {
    mode = "live";
    target = snapshot;
    base = snapshot;
    diff = null;
  } else {
    return empty();
  }

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
    if (entry.node.level === "L0") {
      visible.set(id, entry);
      continue;
    }
    if (entry.node.level === "L1" && entry.node.parentId && expandedL0[entry.node.parentId]) {
      visible.set(id, entry);
    }
  }

  /**
   * Focus mode keeps the focused node, its ancestors, its direct children, and
   * every node joined by one non-containment edge. Edges are then limited to
   * those incident to the focus, so the result reads as a direct-neighborhood
   * diagram rather than the full architecture.
   */
  const focused = focusNodeId ? (candidate.get(focusNodeId) ?? null) : null;
  if (focused) {
    const keep = new Set<string>([focused.node.id]);
    const addAncestors = (start: string | null | undefined): void => {
      let id = start ?? null;
      const guard = new Set<string>();
      while (id && !guard.has(id)) {
        guard.add(id);
        keep.add(id);
        id = candidate.get(id)?.node.parentId ?? null;
      }
    };
    addAncestors(focused.node.parentId);
    for (const entry of candidate.values()) {
      if (entry.node.parentId === focused.node.id && entry.node.level !== "facet") {
        keep.add(entry.node.id);
      }
    }
    const addEndpoints = (from: string, to: string, kind: string): void => {
      if (kind === "contains") return;
      if (from === focused.node.id) keep.add(to);
      if (to === focused.node.id) keep.add(from);
    };
    for (const edge of Object.values(target.edges)) {
      addEndpoints(edge.from, edge.to, edge.kind);
    }
    if (diff) {
      for (const change of Object.values(diff.edges)) {
        const edge = change.after ?? change.before;
        if (edge) addEndpoints(edge.from, edge.to, edge.kind);
      }
    }
    for (const id of keep) addAncestors(candidate.get(id)?.node.parentId);
    visible.clear();
    for (const [id, entry] of candidate) {
      if (entry.node.level === "facet" || !keep.has(id)) continue;
      visible.set(id, entry);
    }
  }

  const parentById = new Map<string, string | null>();
  const units = new Map<string, number>();
  const facts = new Map<string, number>();
  for (const node of Object.values(target.nodes)) {
    if (!node.parentId) continue;
    if (node.level === "L1") units.set(node.parentId, (units.get(node.parentId) ?? 0) + 1);
    if (node.level === "facet") facts.set(node.parentId, (facts.get(node.parentId) ?? 0) + 1);
  }
  const removedUnits = new Map<string, number>();
  const removedFacts = new Map<string, number>();
  const factChanges = new Map<string, { added: number; removed: number; modified: number }>();
  if (diff) {
    for (const change of Object.values(diff.nodes)) {
      const node = change.after ?? change.before;
      if (!node?.parentId) continue;
      if (node.level === "L1" && change.change === "removed") {
        removedUnits.set(node.parentId, (removedUnits.get(node.parentId) ?? 0) + 1);
      }
      if (node.level !== "facet") continue;
      const counts = factChanges.get(node.parentId) ?? {
        added: 0,
        removed: 0,
        modified: 0,
      };
      counts[change.change] += 1;
      factChanges.set(node.parentId, counts);
      if (change.change === "removed") {
        removedFacts.set(node.parentId, (removedFacts.get(node.parentId) ?? 0) + 1);
      }
    }
  }

  for (const [id, entry] of visible) {
    const node = entry.node;
    if (node.level === "L1") {
      parentById.set(id, node.parentId && visible.has(node.parentId) ? node.parentId : null);
      continue;
    }
    // External packages are root cards even though the system owns them; this
    // keeps the dependency list from inflating the system block.
    if (node.kind === "external") {
      parentById.set(id, null);
      continue;
    }
    const parent = node.parentId ? visible.get(node.parentId) : null;
    parentById.set(
      id,
      parent && parent.node.level === "L0" && parent.node.kind !== "external"
        ? parent.node.id
        : null,
    );
  }

  const boxes = layoutRegions(visible, parentById);
  const childIdsByParent = new Map<string, string[]>();
  for (const [id, parentId] of parentById) {
    if (!parentId) continue;
    const list = childIdsByParent.get(parentId) ?? [];
    list.push(id);
    childIdsByParent.set(parentId, list);
  }
  for (const list of childIdsByParent.values()) {
    list.sort((left, right) => {
      const a = visible.get(left)?.node;
      const b = visible.get(right)?.node;
      return a && b ? compareNodes(a, b) : left.localeCompare(right);
    });
  }
  // React Flow requires every parent node to appear before its children.
  const orderedIds: string[] = [];
  const visit = (id: string): void => {
    orderedIds.push(id);
    for (const child of childIdsByParent.get(id) ?? []) visit(child);
  };
  for (const id of [...visible.keys()]
    .filter((nodeId) => !parentById.get(nodeId))
    .sort((left, right) => {
      const a = visible.get(left)?.node;
      const b = visible.get(right)?.node;
      return a && b ? compareNodes(a, b) : left.localeCompare(right);
    })) {
    visit(id);
  }

  const flowNodes: ArchGraphNode[] = orderedIds.map((id) => {
    const entry = visible.get(id);
    if (!entry) throw new Error(`Missing visible architecture node: ${id}`);
    const { node, change } = entry;
    const intent = node.intentId
      ? (target.intents[node.intentId] ?? base.intents[node.intentId])
      : undefined;
    const box = boxes.get(node.id);
    const parentId = parentById.get(node.id) ?? null;
    const factCount = node.level === "L1" ? (facts.get(node.id) ?? 0) : 0;
    const moduleCount =
      node.level === "L0"
        ? (childIdsByParent.get(node.id) ?? []).filter(
            (childId) => visible.get(childId)?.node.level === "L0",
          ).length
        : 0;
    return {
      id: node.id,
      type: "arch",
      position: { x: box?.x ?? 0, y: box?.y ?? 0 },
      width: box?.width ?? LEAF_WIDTH.L0,
      height: box?.height ?? LEAF_HEIGHT.L0,
      measured: {
        width: box?.width ?? LEAF_WIDTH.L0,
        height: box?.height ?? LEAF_HEIGHT.L0,
      },
      style: {
        width: box?.width ?? LEAF_WIDTH.L0,
        height: box?.height ?? LEAF_HEIGHT.L0,
      },
      ...(parentId ? { parentId, extent: "parent" as const } : {}),
      data: {
        node,
        change,
        childCount:
          node.level === "L0"
            ? (units.get(node.id) ?? 0) + (removedUnits.get(node.id) ?? 0)
            : factCount + (removedFacts.get(node.id) ?? 0),
        moduleCount,
        factChanges: factChanges.get(node.id) ?? {
          added: 0,
          removed: 0,
          modified: 0,
        },
        intentTitle: intent?.title ?? null,
        selected: selectedNodeId === node.id,
        expanded: Boolean(expandedL0[node.id]),
        expandable:
          node.level === "L0" && (units.get(node.id) ?? 0) + (removedUnits.get(node.id) ?? 0) > 0,
        region: Boolean(box?.region),
      },
      selected: selectedNodeId === node.id,
      draggable: true,
      connectable: false,
    };
  });

  const edgeSource = new Map<string, { edge: ArchEdge; change: ChangeKind | null }>();
  for (const edge of Object.values(target.edges)) {
    // Containment is expressed by the region blocks themselves. Drawing the
    // edge as well would cross every layer and turn the hierarchy into noise.
    if (edge.kind === "contains") continue;
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
    edgeSource.set(edge.id, { edge, change: diff?.edges[edge.id]?.change ?? null });
  }
  if (diff) {
    for (const change of Object.values(diff.edges)) {
      if (change.change !== "removed" || !change.before) continue;
      if (change.before.kind === "contains") continue;
      if (!visible.has(change.before.from) || !visible.has(change.before.to)) continue;
      edgeSource.set(change.id, { edge: change.before, change: "removed" });
    }
  }

  if (focused) {
    for (const [id, entry] of edgeSource) {
      if (entry.edge.from !== focused.node.id && entry.edge.to !== focused.node.id) {
        edgeSource.delete(id);
      }
    }
  }

  const flowEdges: FlowEdge[] = [...edgeSource.values()].map(({ edge, change }) => {
    const stroke = change ? CHANGE_STROKE[change] : "#64748b";
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "default",
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      animated: change === "added",
      zIndex: change ? 3 : 1,
      style: {
        stroke,
        strokeWidth: change ? 1.6 : 1.05,
        strokeOpacity: change ? 0.92 : 0.42,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 10,
        height: 10,
        color: stroke,
      },
    };
  });

  const expandedIds = Object.keys(expandedL0).sort().join(",");

  const signature = [
    replay ? `replay:${replay.id}` : mode === "proposal" ? (proposal?.id ?? "review") : "live",
    expandedIds,
    proposal?.ops.length ?? 0,
    target.recordCount,
    visible.size,
    edgeSource.size,
    focusNodeId ?? "",
  ].join(":");
  const layoutKey = [
    replay ? `replay:${replay.id}` : mode === "proposal" ? (proposal?.id ?? "review") : "live",
    target.lastRecordId,
    target.recordCount,
  ].join(":");

  return {
    nodes: flowNodes,
    edges: flowEdges,
    signature,
    layoutKey,
    nodeCount: flowNodes.length,
    edgeCount: flowEdges.length,
    reviewing: mode !== "live",
    mode,
    focus: focused?.node.id ?? null,
  };
}

export { directChildren };
