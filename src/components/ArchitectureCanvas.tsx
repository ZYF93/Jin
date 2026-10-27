import { useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import {
  ChevronsDown,
  ChevronsUp,
  Crosshair,
  FileCode2,
  GitBranch,
  Layers3,
  X,
} from "lucide-react";
import type { ChangeKind } from "../../shared/arch/diff";
import type { ArchNode } from "../../shared/arch/types";
import { buildArchitectureGraph, type ArchGraphNode } from "../lib/graph";
import {
  changeLabel,
  isReviewing,
  kindLabel,
  ordinalLabel,
  nextOrdinal,
} from "../lib/utils";
import { useJin } from "../state/useJin";

const NODE_TYPES = { arch: ArchitectureNodeView };

function dotClass(node: ArchNode): string {
  if (node.status === "planned") return "status-dot warning";
  if (node.status === "deprecated") return "status-dot danger";
  return "status-dot success";
}

function changeGlyph(change: ChangeKind | null): string {
  if (change === "added") return "+";
  if (change === "removed") return "−";
  if (change === "modified") return "~";
  return "";
}

function ArchitectureNodeView({ data, selected }: NodeProps<ArchGraphNode>) {
  const node = data.node;
  const change = data.change;
  const level = node.level.toLowerCase();
  const path = node.file || node.path || "unmapped";
  return (
    <div
      className={[
        "arch-node",
        level,
        change ?? "",
        selected ? "is-selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={`${node.name}\n${node.responsibility || node.path}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="arch-node-head">
        <span className={dotClass(node)} />
        <span className="arch-node-kind">{kindLabel(node.kind)}</span>
        <span className="chip ml-auto h-[17px] px-1.5 text-[8px]">{node.level}</span>
        {change ? (
          <span className={`arch-change-badge ${change}`} title={changeLabel(change)}>
            {changeGlyph(change)}
          </span>
        ) : null}
      </div>
      <div className="arch-node-name">{node.name}</div>
      <div className="arch-node-detail">
        {node.responsibility || "No responsibility recorded yet."}
      </div>
      <div className="arch-node-foot">
        <span className="truncate">{path}</span>
        {data.childCount > 0 ? (
          <span className="ml-auto shrink-0">
            {data.childCount} {node.level === "L0" ? "unit" : "facet"}
            {data.childCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

interface InspectorProps {
  node: ArchGraphNode;
  onClose: () => void;
}

function NodeInspector({ node, onClose }: InspectorProps) {
  const detail = node.data.node;
  const app = useJin((state) => state.app);
  const proposal = app?.proposal ?? null;
  const setLeftTab = useJin((state) => state.setLeftTab);
  const setSelectedNode = useJin((state) => state.setSelectedNode);
  const openFile = useJin((state) => state.openFile);
  const change = proposal?.diff.nodes[detail.id];
  const reviewing = isReviewing(proposal);
  const fields = reviewing && change?.change === "modified" ? change.fields : [];
  const snapshot = reviewing && proposal ? proposal.targetSnapshot : app?.snapshot;
  const children = snapshot
    ? Object.values(snapshot.nodes)
        .filter((item) => item.parentId === detail.id)
        .sort((left, right) => left.name.localeCompare(right.name))
    : [];
  const facets = children.filter((item) => item.level === "facet");
  const units = children.filter((item) => item.level !== "facet");

  const revealFile = (): void => {
    if (!detail.file) return;
    setLeftTab("files");
    void openFile(detail.file);
  };

  return (
    <aside className="node-inspector">
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--border)] p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={dotClass(detail)} />
            <span className="chip">{detail.level}</span>
            <span className="chip">{kindLabel(detail.kind)}</span>
            {reviewing && node.data.change ? (
              <span
                className={`chip ${
                  node.data.change === "added"
                    ? "chip-success"
                    : node.data.change === "removed"
                      ? "chip-danger"
                      : "chip-warning"
                }`}
              >
                {changeLabel(node.data.change)}
              </span>
            ) : null}
          </div>
          <div className="mt-2 truncate text-[14px] font-bold">{detail.name}</div>
          <div className="font-mono-ui mt-0.5 truncate text-[9.5px] text-[var(--faint)]">
            {detail.id}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close inspector">
          <X size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="space-y-2.5 text-[11px]">
          <div>
            <div className="panel-title mb-1">Responsibility</div>
            <p className="leading-relaxed text-[var(--muted)]">
              {detail.responsibility || "No responsibility has been approved yet."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="inner-panel p-2">
              <div className="panel-title mb-1">Path</div>
              <div className="font-mono-ui truncate text-[10px] text-[var(--muted)]">
                {detail.path || "—"}
              </div>
            </div>
            <div className="inner-panel p-2">
              <div className="panel-title mb-1">Status</div>
              <div className="text-[10px] capitalize text-[var(--muted)]">{detail.status}</div>
            </div>
          </div>
          {detail.file ? (
            <button
              className="inner-panel flex w-full items-center gap-2 p-2 text-left transition-colors hover:bg-[var(--control)]"
              onClick={revealFile}
            >
              <FileCode2 size={13} className="shrink-0 text-[var(--accent)]" />
              <span className="font-mono-ui min-w-0 flex-1 truncate text-[10px] text-[var(--muted)]">
                {detail.file}
              </span>
            </button>
          ) : null}
          {node.data.intentTitle ? (
            <div className="inner-panel p-2">
              <div className="panel-title mb-1">Intent</div>
              <div className="line-clamp-2 text-[10px] text-[var(--muted)]">
                {node.data.intentTitle}
              </div>
            </div>
          ) : null}
          {facets.length > 0 ? (
            <div>
              <div className="panel-title mb-1">
                Facets ({facets.length})
              </div>
              <div className="space-y-1">
                {facets.map((facet) => (
                  <button
                    key={facet.id}
                    className="inner-panel flex w-full items-center gap-2 p-2 text-left transition-colors hover:bg-[var(--control)]"
                    onClick={() => setSelectedNode(facet.id)}
                  >
                    <span className="chip h-[18px] px-1.5 text-[8px]">
                      {kindLabel(facet.kind)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--muted)]">
                      {facet.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {units.length > 0 ? (
            <div>
              <div className="panel-title mb-1">Contains ({units.length})</div>
              <div className="space-y-1">
                {units.map((unit) => (
                  <button
                    key={unit.id}
                    className="inner-panel flex w-full items-center gap-2 p-2 text-left transition-colors hover:bg-[var(--control)]"
                    onClick={() => setSelectedNode(unit.id)}
                  >
                    <span className="chip h-[18px] px-1.5 text-[8px]">{unit.level}</span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--muted)]">
                      {unit.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {fields.length > 0 ? (
            <div className="inner-panel border-amber-400/20 p-2">
              <div className="panel-title mb-1 text-[var(--warning)]">Changed fields</div>
              <div className="flex flex-wrap gap-1">
                {fields.map((field) => (
                  <span key={field} className="chip chip-warning h-[19px] text-[8px]">
                    {field}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {detail.metadata && Object.keys(detail.metadata).length > 0 ? (
            <details className="text-[10px] text-[var(--faint)]">
              <summary className="cursor-pointer select-none">Metadata</summary>
              <pre className="font-mono-ui mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--code-bg)] p-2 text-[9px]">
                {JSON.stringify(detail.metadata, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function EmptyGraph() {
  const scan = useJin((state) => state.app?.scan);
  const busy = useJin((state) => state.busy);
  const project = useJin((state) => state.app?.project);
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="glass max-w-[410px] rounded-2xl p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--accent-soft)] text-[var(--accent)]">
          <Layers3 size={22} />
        </div>
        <h3 className="mt-4 text-[15px] font-bold">
          {project ? "No architecture nodes yet" : "Open a project to see its architecture"}
        </h3>
        <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--muted)]">
          {project
            ? "Scan the source tree to create the first reviewable L0/L1 import proposal."
            : "Jin turns a codebase into a reviewable architecture, then keeps code and architecture in sync."}
        </p>
        {project ? (
          <button
            className="btn btn-primary mt-4"
            disabled={Boolean(busy)}
            onClick={() => void useJin.getState().scan()}
          >
            <Crosshair size={13} />
            {scan?.phase === "scanning" ? "Scanning…" : "Scan architecture"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function GraphInner({ compact = false }: { compact?: boolean }) {
  const app = useJin((state) => state.app);
  const expanded = useJin((state) => state.expanded);
  const selectedNodeId = useJin((state) => state.selectedNodeId);
  const setExpanded = useJin((state) => state.setExpanded);
  const setSelectedNode = useJin((state) => state.setSelectedNode);
  const { fitView } = useReactFlow();

  const proposal = app?.proposal ?? null;
  const reviewing = isReviewing(proposal);
  const model = useMemo(
    () =>
      buildArchitectureGraph(
        app?.snapshot ?? null,
        proposal,
        expanded,
        selectedNodeId,
      ),
    [app?.snapshot, proposal, expanded, selectedNodeId],
  );

  useEffect(() => {
    if (model.nodes.length === 0) return;
    const timer = window.setTimeout(() => {
      void fitView({ padding: compact ? 0.12 : 0.18, duration: 280 });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [compact, fitView, model.signature, model.nodes.length]);

  const selected = model.nodes.find((node) => node.id === selectedNodeId) ?? null;

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden">
      <div className="relative min-w-0 flex-1 overflow-hidden">
      {model.nodes.length > 0 ? (
        <ReactFlow
          key={model.signature}
          nodes={model.nodes}
          edges={model.edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: compact ? 0.12 : 0.18 }}
          minZoom={0.08}
          maxZoom={1.8}
          nodesConnectable={false}
          nodesDraggable
          elementsSelectable
          selectNodesOnDrag={false}
          panOnScroll
          zoomOnDoubleClick={false}
          onNodeClick={(_event, node) => setSelectedNode(node.id)}
          onPaneClick={() => setSelectedNode(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1}
            color="var(--border-strong)"
          />
          {!compact && !selected && model.nodes.length > 9 ? (
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              nodeColor={(node) => {
                const change = (node.data as { change?: ChangeKind | null }).change;
                if (change === "added") return "var(--success)";
                if (change === "removed") return "var(--danger)";
                if (change === "modified") return "var(--warning)";
                return "var(--faint)";
              }}
              maskColor="var(--minimap-mask)"
            />
          ) : null}
        </ReactFlow>
      ) : (
        <EmptyGraph />
      )}

      <div className="absolute top-3 left-3 z-20 flex items-center gap-2">
        <div className="glass flex items-center gap-1 rounded-lg p-1">
          <button
            className={`btn h-7 gap-1.5 border-0 px-2 text-[10px] ${expanded ? "bg-[var(--control-hover)]" : ""}`}
            onClick={() => setExpanded(true)}
            title="Expand all levels"
          >
            <ChevronsUp size={12} />
            {compact ? null : "Expand all"}
          </button>
          <button
            className={`btn h-7 gap-1.5 border-0 px-2 text-[10px] ${!expanded ? "bg-[var(--control-hover)]" : ""}`}
            onClick={() => setExpanded(false)}
            title="Collapse to L0"
          >
            <ChevronsDown size={12} />
            {compact ? null : "Collapse all"}
          </button>
          <span className="mx-0.5 h-4 w-px bg-[var(--border)]" />
          <button
            className="icon-btn h-7 w-7"
            onClick={() => void fitView({ padding: 0.16, duration: 220 })}
            title="Fit graph"
          >
            <Crosshair size={12} />
          </button>
        </div>
        {reviewing ? (
          <span className="chip chip-warning">
            <GitBranch size={10} />
            {ordinalLabel(nextOrdinal(app?.snapshot))} diff
          </span>
        ) : (
          <span className="chip">
            {model.nodeCount} nodes · {expanded ? "all levels" : "L0 only"}
          </span>
        )}
      </div>

      {reviewing && !(selected && !compact) ? (
        <div className="glass graph-legend absolute top-3 right-3 z-20">
          <span className="flex items-center gap-1.5">
            <span className="legend-swatch bg-emerald-400" /> added
          </span>
          <span className="flex items-center gap-1.5">
            <span className="legend-swatch bg-rose-400" /> removed
          </span>
          <span className="flex items-center gap-1.5">
            <span className="legend-swatch bg-amber-300" /> modified
          </span>
        </div>
      ) : null}
      </div>

      {!compact && selected ? (
        <NodeInspector node={selected} onClose={() => setSelectedNode(null)} />
      ) : null}
    </div>
  );
}

export function ArchitectureCanvas({ compact = false }: { compact?: boolean }) {
  return (
    <ReactFlowProvider>
      <GraphInner compact={compact} />
    </ReactFlowProvider>
  );
}

export { changeGlyph };
