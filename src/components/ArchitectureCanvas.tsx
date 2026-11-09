import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Crosshair,
  FileCode2,
  GitBranch,
  GitCompareArrows,
  Layers3,
  LockKeyhole,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import type { ArchDiff, ChangeKind } from "../../shared/arch/diff";
import type { ArchEdge, ArchNode, ArchSnapshot, Intent, NodeIntent } from "../../shared/ledger/types";
import { buildDemoGraph } from "../lib/demo-graph";
import {
  buildArchitectureGraph,
  type ArchGraphNode,
  type ExpandedL0,
  type GraphReplay,
} from "../lib/graph";
import { useT } from "../lib/i18n";
import {
  changeLabel,
  isReviewing,
  kindLabel,
  nextOrdinal,
  nodeStatusLabel,
  ordinalLabel,
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

function changeChipClass(change: ChangeKind | null): string {
  if (change === "added") return "chip-success";
  if (change === "removed") return "chip-danger";
  if (change === "modified") return "chip-warning";
  return "";
}

function ArchitectureNodeView({ data, selected }: NodeProps<ArchGraphNode>) {
  const t = useT();
  const node = data.node;
  const change = data.change;
  const level = node.level.toLowerCase();
  const path = node.file || node.path || t("common.unmapped");
  const facts = data.factChanges;
  const changeBadge = change ? (
    <span className={`arch-change-badge ${change}`} title={changeLabel(change)}>
      {changeGlyph(change)}
    </span>
  ) : null;

  if (data.region) {
    return (
      <div
        className={[
          "arch-region",
          level,
          change ?? "",
          selected ? "is-selected" : "",
          data.expanded ? "is-expanded" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={`${node.name}\n${node.responsibility || node.path}${
          data.expandable
            ? `\n${data.expanded ? t("graph.clickCollapse") : t("graph.clickReveal")}`
            : ""
        }`}
      >
        <Handle type="target" position={Position.Top} />
        <div className="arch-region-head">
          <div className="arch-node-head">
            <span className={dotClass(node)} />
            <span className="arch-node-kind">{kindLabel(node.kind)}</span>
            <span className="chip ml-auto h-[17px] px-1.5 text-[8px]">{node.level}</span>
            {changeBadge}
          </div>
          <div className="arch-node-name">{node.name}</div>
          <div className="arch-node-foot">
            <span className="truncate">{path}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {data.moduleCount > 0 ? (
                <span>
                  {t("graph.moduleCount", {
                    display: data.moduleCount,
                    count: data.moduleCount,
                  })}
                </span>
              ) : null}
              {data.childCount > 0 ? (
                <span>
                  {t("graph.units", {
                    display: data.childCount,
                    count: data.childCount,
                  })}
                </span>
              ) : null}
              {data.change ? (
                <span className="text-[var(--faint)]">{changeLabel(data.change)}</span>
              ) : null}
              {data.expandable ? (
                data.expanded ? (
                  <ChevronDown size={11} />
                ) : (
                  <ChevronRight size={11} />
                )
              ) : null}
            </span>
          </div>
        </div>
        <div
          className="arch-region-body"
          onClick={(event) => event.stopPropagation()}
          aria-hidden="true"
        />
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  return (
    <div
      className={[
        "arch-node",
        level,
        change ?? "",
        selected ? "is-selected" : "",
        data.expanded ? "is-expanded" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={
        data.expandable
          ? `${node.name}\n${node.responsibility || node.path}\n${
              data.expanded ? t("graph.clickCollapse") : t("graph.clickReveal")
            }`
          : `${node.name}\n${node.responsibility || node.path}`
      }
    >
      <Handle type="target" position={Position.Top} />
      <div className="arch-node-head">
        <span className={dotClass(node)} />
        <span className="arch-node-kind">{kindLabel(node.kind)}</span>
        <span className="chip ml-auto h-[17px] px-1.5 text-[8px]">{node.level}</span>
        {changeBadge}
      </div>
      <div className="arch-node-name">{node.name}</div>
      <div className="arch-node-detail">{node.responsibility || t("graph.noResponsibility")}</div>
      <div className="arch-node-foot">
        <span className="truncate">{path}</span>
        {node.level === "L0" && data.childCount > 0 ? (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {t("graph.units", {
              display: data.childCount,
              count: data.childCount,
            })}
            {data.expandable ? (
              data.expanded ? (
                <ChevronDown size={10} />
              ) : (
                <ChevronRight size={10} />
              )
            ) : null}
          </span>
        ) : node.level === "L1" && data.childCount > 0 ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <span>
              {t("graph.facts", {
                display: data.childCount,
                count: data.childCount,
              })}
            </span>
            {facts.added > 0 ? <span className="text-[var(--success)]">+{facts.added}</span> : null}
            {facts.removed > 0 ? (
              <span className="text-[var(--danger)]">−{facts.removed}</span>
            ) : null}
            {facts.modified > 0 ? (
              <span className="text-[var(--warning)]">~{facts.modified}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

interface InspectorContext {
  snapshot: ArchSnapshot;
  diff: ArchDiff | null;
  intent: Intent | null;
  readOnly: boolean;
}

interface InspectorProps {
  node: ArchGraphNode;
  onClose: () => void;
  context: InspectorContext;
  focused: boolean;
  onToggleFocus: () => void;
}

interface ResolvedIntent {
  intent: Intent;
  nodeIntent: NodeIntent;
}

function intentFor(
  snapshot: ArchSnapshot,
  preferred: Intent | null,
  nodeId: string,
  facetId?: string,
): ResolvedIntent | null {
  const match = (intent: Intent | null | undefined): ResolvedIntent | null => {
    if (!intent) return null;
    const nodeIntent = intent.nodeIntents.find(
      (entry) => entry.nodeId === nodeId && (entry.facetId ?? null) === (facetId ?? null),
    );
    return nodeIntent ? { intent, nodeIntent } : null;
  };
  const direct = match(preferred);
  if (direct) return direct;
  const candidates = Object.values(snapshot.intents)
    .filter((intent) => {
      const versionId = intent.versionId;
      return snapshot.versions[versionId];
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const intent of candidates) {
    const hit = match(intent);
    if (hit) return hit;
  }
  return null;
}

function factsFor(snapshot: ArchSnapshot, diff: ArchDiff | null, nodeId: string): ArchNode[] {
  const byId = new Map<string, ArchNode>();
  for (const node of Object.values(snapshot.nodes)) {
    if (node.parentId === nodeId && node.level === "facet") byId.set(node.id, node);
  }
  if (diff) {
    for (const change of Object.values(diff.nodes)) {
      const before = change.before;
      if (change.change === "removed" && before?.level === "facet" && before.parentId === nodeId) {
        byId.set(before.id, before);
      }
    }
  }
  const rank: Record<string, number> = { method: 0, field: 1, property: 2 };
  return [...byId.values()].sort(
    (left, right) =>
      (rank[left.kind] ?? 3) - (rank[right.kind] ?? 3) || left.name.localeCompare(right.name),
  );
}

function unitRows(
  snapshot: ArchSnapshot,
  diff: ArchDiff | null,
  nodeId: string,
  level: "L0" | "L1",
): ArchNode[] {
  const byId = new Map<string, ArchNode>();
  for (const node of Object.values(snapshot.nodes)) {
    if (node.parentId === nodeId && node.level === level) byId.set(node.id, node);
  }
  if (diff) {
    for (const change of Object.values(diff.nodes)) {
      const before = change.before;
      if (change.change === "removed" && before?.level === level && before.parentId === nodeId) {
        byId.set(before.id, before);
      }
    }
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

interface RelationRow {
  edge: ArchEdge;
  direction: "out" | "in";
  other: ArchNode;
  change: ChangeKind | null;
}

/** One-hop non-containment relationships, including edges removed by a diff. */
function directRelations(
  snapshot: ArchSnapshot,
  diff: ArchDiff | null,
  nodeId: string,
): RelationRow[] {
  const nodes = new Map(Object.values(snapshot.nodes).map((node) => [node.id, node]));
  if (diff) {
    for (const change of Object.values(diff.nodes)) {
      if (change.before && !nodes.has(change.before.id)) {
        nodes.set(change.before.id, change.before);
      }
    }
  }
  const rows = new Map<string, RelationRow>();
  const add = (edge: ArchEdge, change: ChangeKind | null): void => {
    if (edge.kind === "contains") return;
    const direction = edge.from === nodeId ? "out" : edge.to === nodeId ? "in" : null;
    if (!direction) return;
    const other = nodes.get(direction === "out" ? edge.to : edge.from);
    if (!other || other.level === "facet") return;
    rows.set(edge.id, { edge, direction, other, change });
  };
  for (const edge of Object.values(snapshot.edges)) {
    add(edge, diff?.edges[edge.id]?.change ?? null);
  }
  if (diff) {
    for (const change of Object.values(diff.edges)) {
      if (change.change === "removed" && change.before) add(change.before, "removed");
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      left.other.name.localeCompare(right.other.name) ||
      left.edge.kind.localeCompare(right.edge.kind),
  );
}

function NodeInspector({ node, onClose, context, focused, onToggleFocus }: InspectorProps) {
  const t = useT();
  const detail = node.data.node;
  const setSelectedNode = useJin((state) => state.setSelectedNode);
  const setExpandedL0 = useJin((state) => state.setExpandedL0);
  const setLeftTab = useJin((state) => state.setLeftTab);
  const setIntentsCollapsed = useJin((state) => state.setIntentsCollapsed);
  const openFile = useJin((state) => state.openFile);
  const { snapshot, diff, intent } = context;
  const directChange = diff?.nodes[detail.id]?.change ?? null;
  const propagated = diff?.colors[detail.id] ?? null;
  const fields = directChange === "modified" ? (diff?.nodes[detail.id]?.fields ?? []) : [];
  const facets = detail.level === "L1" ? factsFor(snapshot, diff, detail.id) : [];
  const childModules = detail.level === "L0" ? unitRows(snapshot, diff, detail.id, "L0") : [];
  const childUnits = detail.level === "L0" ? unitRows(snapshot, diff, detail.id, "L1") : [];
  const relations = directRelations(snapshot, diff, detail.id);
  const nodeIntent = intentFor(snapshot, intent, detail.id);
  const factGroups = [
    { kind: "method", title: "graph.methods" },
    { kind: "field", title: "graph.fields" },
    { kind: "property", title: "graph.properties" },
  ] as const;
  const exports = Array.isArray(detail.metadata.exports)
    ? detail.metadata.exports.filter((item): item is string => typeof item === "string")
    : [];
  const symbolLocations =
    typeof detail.metadata.symbolLocations === "object" && detail.metadata.symbolLocations !== null
      ? (detail.metadata.symbolLocations as Record<string, unknown>)
      : {};
  const factCount = facets.length;
  const changedFactCount = facets.filter((facet) => diff?.nodes[facet.id]?.change).length;

  const reveal = (id: string): void => {
    const target = snapshot.nodes[id];
    if (target?.level === "L0") setExpandedL0(id, true);
    else if (target?.parentId) setExpandedL0(target.parentId, true);
    setSelectedNode(id);
  };

  // L1 nodes always map to a source file. Facet nodes inherit it too. L0
  // directories deliberately do not open as files.
  const filePath = detail.file || (detail.level !== "L0" ? detail.path : "");

  const revealFile = (line?: number): void => {
    if (!filePath) return;
    setIntentsCollapsed(false);
    setLeftTab("files");
    void openFile(filePath, line);
  };

  return (
    <aside className="node-inspector">
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--border)] p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={dotClass(detail)} />
            <span className="chip">{detail.level}</span>
            <span className="chip">{kindLabel(detail.kind)}</span>
            {context.readOnly ? (
              <span className="chip h-[17px] gap-1 px-1.5 text-[8px]">
                <LockKeyhole size={8} /> {t("graph.readOnlyView")}
              </span>
            ) : null}
            {propagated ? (
              <span className={`chip ${changeChipClass(propagated)}`}>
                {changeLabel(propagated)}
                {directChange ? "" : ` · ${t("graph.rolledUp")}`}
              </span>
            ) : null}
          </div>
          <div className="mt-2 truncate text-[14px] font-bold">{detail.name}</div>
          <div className="font-mono-ui mt-0.5 truncate text-[9.5px] text-[var(--faint)]">
            {detail.id}
          </div>
        </div>
        <button
          className={`icon-btn ${focused ? "text-[var(--accent)]" : ""}`}
          onClick={onToggleFocus}
          title={focused ? t("graph.exitFocus") : t("graph.focus")}
          aria-label={focused ? t("graph.exitFocus") : t("graph.focus")}
        >
          <Crosshair size={13} />
        </button>
        <button className="icon-btn" onClick={onClose} aria-label={t("graph.closeInspector")}>
          <X size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="space-y-2.5 text-[11px]">
          <div>
            <div className="panel-title mb-1">{t("graph.responsibility")}</div>
            <p className="leading-relaxed text-[var(--muted)]">
              {detail.responsibility || t("graph.noResponsibilityApproved")}
            </p>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-2">
            <button
              type="button"
              className={`inner-panel min-w-0 p-2 text-left ${
                filePath
                  ? "cursor-pointer transition-colors hover:border-cyan-300/30 hover:bg-[var(--control)] disabled:cursor-default"
                  : "cursor-default"
              }`}
              onClick={() => {
                if (filePath) revealFile();
              }}
              disabled={!filePath}
              title={filePath ? t("graph.revealFile") : undefined}
            >
              <div className="panel-title mb-1">{t("graph.path")}</div>
              <div className="font-mono-ui truncate text-[10px] text-[var(--muted)]">
                {detail.path || "—"}
              </div>
            </button>
            <div className="inner-panel p-2">
              <div className="panel-title mb-1">{t("graph.status")}</div>
              <div className="text-[10px] capitalize text-[var(--muted)]">
                {nodeStatusLabel(detail.status)}
              </div>
            </div>
          </div>
          {filePath ? (
            <button
              className="inner-panel flex w-full items-center gap-2 p-2 text-left transition-colors hover:bg-[var(--control)]"
              onClick={() => revealFile()}
            >
              <FileCode2 size={13} className="shrink-0 text-[var(--accent)]" />
              <span className="font-mono-ui min-w-0 flex-1 truncate text-[10px] text-[var(--muted)]">
                {filePath}
              </span>
              <ArrowUpRight size={11} className="shrink-0 text-[var(--faint)]" />
            </button>
          ) : null}

          <div className="inner-panel p-2">
            <div className="flex items-center gap-1.5">
              <span className="panel-title">{t("graph.intent")}</span>
              {nodeIntent ? (
                <span className="chip h-[17px] px-1.5 text-[8px]">
                  {snapshot.versions[nodeIntent.intent.versionId]?.ordinal
                    ? `v${snapshot.versions[nodeIntent.intent.versionId]?.ordinal}`
                    : `v${nodeIntent.intent.versionId.slice(-4)}`}
                </span>
              ) : intent ? (
                <span className="chip h-[17px] px-1.5 text-[8px]">
                  {snapshot.versions[intent.versionId]?.ordinal
                    ? `v${snapshot.versions[intent.versionId]?.ordinal}`
                    : `v${intent.versionId.slice(-4)}`}
                </span>
              ) : null}
            </div>
            {nodeIntent ? (
              <>
                <div className="mt-1 text-[10px] font-semibold text-[var(--muted)]">
                  {nodeIntent.intent.title}
                </div>
                <p className="mt-1 leading-relaxed text-[var(--muted)]">
                  {nodeIntent.nodeIntent.statement}
                </p>
                {nodeIntent.nodeIntent.invariants.length > 0 ? (
                  <div className="mt-1.5 space-y-0.5">
                    {nodeIntent.nodeIntent.invariants.map((invariant) => (
                      <div
                        key={invariant}
                        className="flex items-start gap-1 text-[9px] leading-relaxed text-[var(--faint)]"
                      >
                        <span className="mt-1 h-0.5 w-0.5 shrink-0 rounded-full bg-[var(--faint)]" />
                        <span>{invariant}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : intent ? (
              <>
                <div className="mt-1 text-[10px] font-semibold text-[var(--muted)]">
                  {intent.title}
                </div>
                <p className="mt-1 leading-relaxed text-[var(--muted)]">{intent.goal}</p>
                <div className="mt-1 text-[8.5px] text-[var(--faint)]">
                  {t("graph.versionIntent")}
                </div>
              </>
            ) : (
              <p className="mt-1 text-[9.5px] leading-relaxed text-[var(--faint)]">
                {t("graph.noNodeIntent")}
              </p>
            )}
          </div>

          <div className="inner-panel p-2">
            <div className="flex items-center gap-1.5">
              <span className="panel-title">{t("graph.relations")}</span>
              <span className="chip h-[17px] px-1.5 text-[8px]">{relations.length}</span>
            </div>
            {relations.length === 0 ? (
              <p className="mt-1.5 text-[9.5px] text-[var(--faint)]">{t("graph.noRelations")}</p>
            ) : (
              <div className="mt-1.5 space-y-1">
                {relations.map((row) => (
                  <button
                    key={row.edge.id}
                    className="flex w-full items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-soft)] px-1.5 py-1 text-left transition-colors hover:bg-[var(--control)]"
                    onClick={() => reveal(row.other.id)}
                    title={
                      row.direction === "out"
                        ? t("graph.outgoingRelation")
                        : t("graph.incomingRelation")
                    }
                  >
                    {row.direction === "out" ? (
                      <ArrowUpRight size={10} className="shrink-0 text-[var(--accent)]" />
                    ) : (
                      <ArrowDownLeft size={10} className="shrink-0 text-[var(--violet)]" />
                    )}
                    <span className="chip h-[16px] shrink-0 px-1 text-[7.5px]">
                      {kindLabel(row.edge.kind)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[9.5px] text-[var(--muted)]">
                      {row.other.name}
                    </span>
                    {row.change ? (
                      <span
                        className={`chip h-[16px] shrink-0 px-1 text-[7.5px] ${changeChipClass(row.change)}`}
                      >
                        {changeGlyph(row.change)}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>

          {detail.level === "L1" ? (
            <div className="inner-panel border-[var(--border-strong)] p-2">
              <div className="flex items-center gap-1.5">
                <span className="panel-title">{t("graph.factsTitle")}</span>
                <span className="chip h-[17px] px-1.5 text-[8px]">{factCount}</span>
                {changedFactCount > 0 ? (
                  <span className="chip chip-warning ml-auto h-[17px] px-1.5 text-[8px]">
                    {t("common.changed", { count: changedFactCount })}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-[9px] leading-relaxed text-[var(--faint)]">
                {t("graph.factsHint")}
              </p>
              {factCount === 0 ? (
                <p className="mt-2 text-[9.5px] text-[var(--faint)]">{t("graph.noFacts")}</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {factGroups.map((group) => {
                    const items = facets.filter((facet) => facet.kind === group.kind);
                    if (items.length === 0) return null;
                    return (
                      <div key={group.kind}>
                        <div className="mb-1 flex items-center gap-1.5 text-[8.5px] font-semibold tracking-wide text-[var(--faint)] uppercase">
                          {t(group.title)}
                          <span className="chip h-[16px] px-1 text-[7.5px]">{items.length}</span>
                        </div>
                        <div className="space-y-1">
                          {items.map((facet) => {
                            const factChange = diff?.nodes[facet.id]?.change ?? null;
                            const factIntent = intentFor(snapshot, intent, detail.id, facet.id);
                            return (
                              <button
                                type="button"
                                key={facet.id}
                                className={`w-full cursor-pointer rounded-md border px-2 py-1.5 text-left transition-colors hover:border-cyan-300/30 hover:bg-[var(--control)] ${
                                  factChange === "added"
                                    ? "border-emerald-400/30 bg-emerald-400/[0.05]"
                                    : factChange === "removed"
                                      ? "border-rose-400/30 bg-rose-400/[0.05]"
                                      : factChange === "modified"
                                        ? "border-amber-300/30 bg-amber-300/[0.05]"
                                        : "border-[var(--border)] bg-[var(--panel-soft)]"
                                }`}
                                onClick={() => {
                                  const line = facet.metadata.line;
                                  revealFile(typeof line === "number" ? line : undefined);
                                }}
                                title={
                                  typeof facet.metadata.line === "number"
                                    ? t("graph.revealFact")
                                    : t("graph.revealFile")
                                }
                              >
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono-ui min-w-0 flex-1 truncate text-[9.5px] text-[var(--muted)]">
                                    {facet.name}
                                  </span>
                                  {factChange ? (
                                    <span
                                      className={`chip h-[16px] px-1 text-[7.5px] ${changeChipClass(factChange)}`}
                                    >
                                      {changeGlyph(factChange)} {changeLabel(factChange)}
                                    </span>
                                  ) : null}
                                </div>
                                {factIntent ? (
                                  <div className="mt-1 text-[8.5px] leading-relaxed text-[var(--faint)]">
                                    {factIntent.nodeIntent.statement}
                                  </div>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {exports.length > 0 ? (
                <div className="mt-2">
                  <div className="mb-1 text-[8.5px] font-semibold tracking-wide text-[var(--faint)] uppercase">
                    {t("graph.otherFacts")}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {exports.slice(0, 12).map((name) => (
                      <button
                        type="button"
                        key={name}
                        className="chip h-[18px] cursor-pointer px-1.5 text-[8px] transition-colors hover:border-cyan-300/40 hover:text-[var(--text)]"
                        onClick={() => {
                          const line =
                            facets.find((facet) => facet.name === name)?.metadata.line ??
                            (symbolLocations[name] as { line?: unknown } | undefined)?.line;
                          revealFile(typeof line === "number" ? line : undefined);
                        }}
                        title={
                          typeof (symbolLocations[name] as { line?: unknown } | undefined)?.line ===
                          "number"
                            ? t("graph.revealFact")
                            : t("graph.revealFile")
                        }
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {detail.level === "L0" ? (
            <>
              {childModules.length > 0 ? (
                <div>
                  <div className="panel-title mb-1">
                    {t("graph.modules", { count: childModules.length })}
                  </div>
                  <div className="space-y-1">
                    {childModules.map((unit) => (
                      <button
                        key={unit.id}
                        className="inner-panel flex w-full items-center gap-2 p-2 text-left transition-colors hover:bg-[var(--control)]"
                        onClick={() => reveal(unit.id)}
                      >
                        <span className="chip h-[18px] px-1.5 text-[8px]">
                          {kindLabel(unit.kind)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--muted)]">
                          {unit.name}
                        </span>
                        {diff?.colors[unit.id] ? (
                          <span
                            className={`chip h-[17px] px-1 text-[7.5px] ${changeChipClass(diff.colors[unit.id])}`}
                          >
                            {changeGlyph(diff.colors[unit.id])}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {childUnits.length > 0 ? (
                <div>
                  <div className="panel-title mb-1">
                    {t("graph.l1Units", { count: childUnits.length })}
                  </div>
                  <div className="space-y-1">
                    {childUnits.map((unit) => {
                      const unitFacts = factsFor(snapshot, diff, unit.id);
                      return (
                        <button
                          key={unit.id}
                          className="inner-panel flex w-full items-center gap-2 p-2 text-left transition-colors hover:bg-[var(--control)]"
                          onClick={() => reveal(unit.id)}
                        >
                          <span className="chip h-[18px] px-1.5 text-[8px]">{unit.level}</span>
                          <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--muted)]">
                            {unit.name}
                          </span>
                          <span className="shrink-0 text-[8px] text-[var(--faint)]">
                            {t("graph.noFactsForUnit", { count: unitFacts.length })}
                          </span>
                          {diff?.colors[unit.id] ? (
                            <span
                              className={`chip h-[17px] px-1 text-[7.5px] ${changeChipClass(diff.colors[unit.id])}`}
                            >
                              {changeGlyph(diff.colors[unit.id])}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {fields.length > 0 ? (
            <div className="inner-panel border-amber-400/20 p-2">
              <div className="panel-title mb-1 text-[var(--warning)]">
                {t("graph.changedFields")}
              </div>
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
              <summary className="cursor-pointer select-none">{t("graph.metadata")}</summary>
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
  const t = useT();
  const scan = useJin((state) => state.app?.scan);
  const busy = useJin((state) => state.busy);
  const project = useJin((state) => state.app?.project);
  const setDemoGraph = useJin((state) => state.setDemoGraph);
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="glass max-w-[410px] rounded-2xl p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--accent-soft)] text-[var(--accent)]">
          <Layers3 size={22} />
        </div>
        <h3 className="mt-4 text-[15px] font-bold">
          {project ? t("graph.emptyNoNodes") : t("graph.emptyOpen")}
        </h3>
        <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--muted)]">
          {project ? t("graph.emptyScanHint") : t("graph.emptyOpenHint")}
        </p>
        {project ? (
          <button
            className="btn btn-primary mt-4"
            disabled={Boolean(busy)}
            onClick={() => void useJin.getState().scan()}
          >
            <Crosshair size={13} />
            {scan?.phase === "scanning" ? t("graph.scanning") : t("graph.scan")}
          </button>
        ) : (
          <button className="btn mt-4" onClick={() => setDemoGraph(true)}>
            <Sparkles size={13} />
            {t("graph.openDemo")}
          </button>
        )}
      </div>
    </div>
  );
}

function graphSnapshot(
  app: ReturnType<typeof useJin.getState>["app"],
  replay: GraphReplay | null,
): ArchSnapshot | null {
  if (replay) return replay.targetSnapshot;
  if (app?.proposal && isReviewing(app.proposal)) return app.proposal.targetSnapshot;
  return app?.snapshot ?? null;
}

function GraphInner({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const app = useJin((state) => state.app);
  const storeExpanded = useJin((state) => state.expandedL0);
  const storeSelectedNodeId = useJin((state) => state.selectedNodeId);
  const storeToggleExpandedL0 = useJin((state) => state.toggleExpandedL0);
  const storeSetSelectedNode = useJin((state) => state.setSelectedNode);
  const storeFocusNodeId = useJin((state) => state.focusNodeId);
  const storeSetFocusNode = useJin((state) => state.setFocusNode);
  const demoGraph = useJin((state) => state.demoGraph);
  const expandAllL0 = useJin((state) => state.expandAllL0);
  const collapseAllL0 = useJin((state) => state.collapseAllL0);
  const selectedVersionId = useJin((state) => state.selectedVersionId);
  const versionReplay = useJin((state) => state.versionReplay);
  const versionReplayLoading = useJin((state) => state.versionReplayLoading);
  const versionReplayError = useJin((state) => state.versionReplayError);
  const [localExpanded, setLocalExpanded] = useState<ExpandedL0>({});
  const [localSelectedNodeId, setLocalSelectedNodeId] = useState<string | null>(null);
  const [localFocusNodeId, setLocalFocusNodeId] = useState<string | null>(null);
  /** Node to re-center after an expansion; unrelated to focus mode. */
  const [centerNodeId, setCenterNodeId] = useState<string | null>(null);
  const expandedL0 = compact ? localExpanded : storeExpanded;
  const selectedNodeId = compact ? localSelectedNodeId : storeSelectedNodeId;
  const setSelectedNode = compact ? setLocalSelectedNodeId : storeSetSelectedNode;
  const focusNodeId = compact ? localFocusNodeId : storeFocusNodeId;
  const setFocusNode = compact ? setLocalFocusNodeId : storeSetFocusNode;
  const toggleExpandedL0 = compact
    ? (id: string) => {
        setLocalExpanded((current) => {
          const next = { ...current };
          if (next[id]) delete next[id];
          else next[id] = true;
          return next;
        });
      }
    : storeToggleExpandedL0;
  const { getViewport, getInternalNode, getNodes, setCenter, setViewport } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);
  const proposal = app?.proposal ?? null;
  const demo = useMemo(
    () => (demoGraph && !compact ? buildDemoGraph() : null),
    [compact, demoGraph],
  );
  const replayGraph = useMemo<GraphReplay | null>(() => {
    if (compact) return null;
    if (demo) return demo.replay;
    if (!selectedVersionId || versionReplay?.versionId !== selectedVersionId) return null;
    return {
      id: versionReplay.versionId,
      baseSnapshot: versionReplay.baseSnapshot,
      targetSnapshot: versionReplay.targetSnapshot,
      diff: versionReplay.diff,
    };
  }, [compact, demo, selectedVersionId, versionReplay]);
  const model = useMemo(
    () =>
      buildArchitectureGraph(
        demo?.snapshot ?? app?.snapshot ?? null,
        replayGraph ? null : proposal,
        expandedL0,
        selectedNodeId,
        replayGraph,
        focusNodeId,
      ),
    [app?.snapshot, demo, proposal, expandedL0, selectedNodeId, replayGraph, focusNodeId],
  );

  // Drop a stale focus when the node left the snapshot (project switch, WAL reset).
  useEffect(() => {
    if (focusNodeId && !model.focus) setFocusNode(null);
  }, [focusNodeId, model.focus, setFocusNode]);

  /**
   * React Flow's own fitView waits for its measurement queue and never resolves
   * for these fully predetermined region nodes. The layout already knows every
   * root block's size, so fit directly from the top-level nodes instead.
   */
  const fitCanvas = useCallback(
    (duration = 0) => {
      const nodes = getNodes();
      const roots = nodes.filter((node) => !node.parentId);
      if (roots.length === 0) return;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const node of roots) {
        const width = node.width ?? node.measured?.width ?? 0;
        const height = node.height ?? node.measured?.height ?? 0;
        if (width <= 0 || height <= 0) continue;
        minX = Math.min(minX, node.position.x);
        minY = Math.min(minY, node.position.y);
        maxX = Math.max(maxX, node.position.x + width);
        maxY = Math.max(maxY, node.position.y + height);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;
      const boundsWidth = Math.max(1, maxX - minX);
      const boundsHeight = Math.max(1, maxY - minY);
      const container = canvasRef.current;
      const viewWidth = container?.clientWidth ?? 900;
      const viewHeight = container?.clientHeight ?? 700;
      const padding = compact ? 0.1 : 0.07;
      const availableWidth = viewWidth * (1 - padding * 2);
      const availableHeight = viewHeight * (1 - padding * 2);
      const zoom = Math.max(
        0.08,
        Math.min(1, availableWidth / boundsWidth, availableHeight / boundsHeight),
      );
      void setViewport(
        {
          x: viewWidth / 2 - (minX + boundsWidth / 2) * zoom,
          y: viewHeight / 2 - (minY + boundsHeight / 2) * zoom,
          zoom,
        },
        { duration },
      );
    },
    [compact, getNodes, setViewport],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => fitCanvas(0), 80);
    return () => window.clearTimeout(timer);
  }, [model.layoutKey, fitCanvas]);

  // Entering or leaving focus swaps the whole visible subgraph. Refit so the
  // remaining nodes are not left off-screen at the old viewport.
  const focusFitReady = useRef(false);
  useEffect(() => {
    if (!focusFitReady.current) {
      focusFitReady.current = true;
      return;
    }
    const timer = window.setTimeout(() => fitCanvas(260), 80);
    return () => window.clearTimeout(timer);
  }, [focusNodeId, fitCanvas]);

  useEffect(() => {
    if (!centerNodeId) return;
    const timer = window.setTimeout(() => {
      const internal = getInternalNode(centerNodeId);
      if (!internal) {
        setCenterNodeId(null);
        return;
      }
      const width =
        internal.measured.width ?? (internal as unknown as { width?: number }).width ?? 0;
      const height =
        internal.measured.height ?? (internal as unknown as { height?: number }).height ?? 0;
      if (width <= 0 || height <= 0) {
        setCenterNodeId(null);
        return;
      }
      void setCenter(
        internal.internals.positionAbsolute.x + width / 2,
        internal.internals.positionAbsolute.y + height / 2,
        { zoom: getViewport().zoom, duration: 260 },
      );
      setCenterNodeId(null);
    }, 40);
    return () => window.clearTimeout(timer);
  }, [centerNodeId, getInternalNode, getViewport, setCenter]);
  const reviewing = model.mode !== "live";
  const targetSnapshot = demo?.snapshot ?? graphSnapshot(app, replayGraph);
  const allL0Ids = useMemo(
    () =>
      targetSnapshot
        ? Object.values(targetSnapshot.nodes)
            .filter((node) => node.level === "L0")
            .map((node) => node.id)
        : [],
    [targetSnapshot],
  );
  const expandedCount = Object.keys(expandedL0).length;
  const appliedExpanded = compact ? localExpanded : storeExpanded;
  const applyExpandAll = compact
    ? (ids: string[]) => setLocalExpanded(Object.fromEntries(ids.map((id) => [id, true as const])))
    : expandAllL0;
  const applyCollapseAll = compact ? () => setLocalExpanded({}) : collapseAllL0;

  const inspectorContext: InspectorContext | null = demo
    ? {
        snapshot: demo.snapshot,
        diff: demo.replay.diff,
        intent: demo.snapshot.intents["intent:demo-v2"] ?? null,
        readOnly: true,
      }
    : replayGraph
      ? {
          snapshot: replayGraph.targetSnapshot,
          diff: replayGraph.diff,
          intent: versionReplay?.intent ?? null,
          readOnly: true,
        }
      : proposal && isReviewing(proposal)
        ? {
            snapshot: proposal.targetSnapshot,
            diff: proposal.diff,
            intent: proposal.intent,
            readOnly: true,
          }
        : app?.snapshot
          ? {
              snapshot: app.snapshot,
              diff: null,
              intent: null,
              readOnly: true,
            }
          : null;
  const selected = model.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const replayIntent = demo
    ? (demo.snapshot.intents["intent:demo-v2"] ?? null)
    : (versionReplay?.intent ?? null);
  const focusName = model.focus
    ? (model.nodes.find((node) => node.id === model.focus)?.data.node.name ??
      targetSnapshot?.nodes[model.focus]?.name ??
      null)
    : null;
  const toggleFocus = (id: string): void => setFocusNode(focusNodeId === id ? null : id);

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden">
      <div
        ref={canvasRef}
        className="relative min-w-0 flex-1 overflow-hidden"
        role="region"
        aria-label={t("graph.readOnlyView")}
        aria-readonly="true"
      >
        {versionReplayLoading && !compact ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center">
            <div className="glass flex items-center gap-2.5 rounded-xl px-4 py-3 text-[10.5px] text-[var(--muted)]">
              <Loader2 size={14} className="spin text-[var(--accent)]" />
              {selectedVersionId ? t("graph.replayLoading") : t("graph.replayLoadingHistory")}
            </div>
          </div>
        ) : versionReplayError && !compact ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
            <div className="glass max-w-[420px] rounded-xl p-4 text-center">
              <GitCompareArrows size={18} className="mx-auto text-[var(--danger)]" />
              <div className="mt-2 text-[11px] font-bold">{t("graph.versionUnavailable")}</div>
              <p className="mt-1 text-[10px] leading-relaxed text-[var(--muted)]">
                {versionReplayError}
              </p>
            </div>
          </div>
        ) : model.nodes.length > 0 ? (
          <ReactFlow
            key={model.layoutKey}
            nodes={model.nodes}
            edges={model.edges}
            nodeTypes={NODE_TYPES}
            minZoom={0.08}
            maxZoom={1.8}
            nodesConnectable={false}
            nodesDraggable={false}
            elementsSelectable
            selectNodesOnDrag={false}
            onlyRenderVisibleElements
            panOnScroll
            zoomOnDoubleClick={false}
            onNodeClick={(_event, node) => {
              setSelectedNode(node.id);
              if (node.data.node.level === "L0" && node.data.expandable) {
                const willExpand = !expandedL0[node.id];
                toggleExpandedL0(node.id);
                if (willExpand) setCenterNodeId(node.id);
              }
            }}
            onPaneClick={() => setSelectedNode(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color="var(--border-strong)"
            />
            {!compact && !selected && model.nodes.length > 18 ? (
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

        <div className="absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2">
          <div className="glass flex items-center gap-1 rounded-lg p-1">
            <button
              className={`btn h-7 gap-1.5 border-0 px-2 text-[10px] ${
                expandedCount === allL0Ids.length && allL0Ids.length > 0
                  ? "bg-[var(--control-hover)]"
                  : ""
              }`}
              onClick={() => applyExpandAll(allL0Ids)}
              title={t("graph.expandAllTitle")}
            >
              <ChevronsUp size={12} />
              {compact ? null : t("graph.expandAll")}
            </button>
            <button
              className={`btn h-7 gap-1.5 border-0 px-2 text-[10px] ${
                expandedCount === 0 ? "bg-[var(--control-hover)]" : ""
              }`}
              onClick={applyCollapseAll}
              title={t("graph.collapseAllTitle")}
            >
              <ChevronsDown size={12} />
              {compact ? null : t("graph.collapseAll")}
            </button>
            <span className="mx-0.5 h-4 w-px bg-[var(--border)]" />
            <button
              className="icon-btn h-7 w-7"
              onClick={() => fitCanvas(220)}
              title={t("graph.fit")}
            >
              <Crosshair size={12} />
            </button>
            <span className="mx-0.5 h-4 w-px bg-[var(--border)]" />
            <button
              className={`icon-btn h-7 w-7 ${focusNodeId ? "text-[var(--accent)]" : ""}`}
              onClick={() => {
                if (!selected) return;
                toggleFocus(selected.id);
              }}
              disabled={!selected}
              title={focusNodeId ? t("graph.exitFocus") : t("graph.focusSelected")}
              aria-label={focusNodeId ? t("graph.exitFocus") : t("graph.focusSelected")}
            >
              <Crosshair size={12} />
            </button>
          </div>
          <span className="chip gap-1">
            <LockKeyhole size={9} /> {t("graph.readOnlyView")}
          </span>
          {demo ? (
            <span className="chip chip-accent">
              <Sparkles size={10} />
              {t("graph.demoDiff")}
            </span>
          ) : model.mode === "replay" ? (
            <span className="chip chip-accent">
              <GitCompareArrows size={10} />
              {t("graph.replayDiff", {
                ordinal: ordinalLabel(versionReplay?.ordinal ?? null),
              })}
            </span>
          ) : model.mode === "proposal" ? (
            <span className="chip chip-warning">
              <GitBranch size={10} />
              {t("graph.proposalDiff", {
                ordinal: ordinalLabel(nextOrdinal(app?.snapshot)),
              })}
            </span>
          ) : (
            <span className="chip">
              <Layers3 size={10} />
              {t(Object.keys(appliedExpanded).length > 0 ? "graph.revealed" : "graph.overview", {
                count: model.nodeCount,
              })}
            </span>
          )}
          {focusName ? (
            <button
              className="chip chip-accent max-w-[260px]"
              onClick={() => setFocusNode(null)}
              title={t("graph.exitFocus")}
            >
              <Crosshair size={10} />
              <span className="truncate">{t("graph.focusedOn", { name: focusName })}</span>
              <X size={9} />
            </button>
          ) : null}
          {!compact && replayIntent ? (
            <span className="chip max-w-[320px] truncate">{replayIntent.title}</span>
          ) : null}
        </div>

        {reviewing && !(selected && !compact) ? (
          <div className="glass graph-legend absolute top-3 right-3 z-20">
            <span className="flex items-center gap-1.5">
              <span className="legend-swatch bg-emerald-400" /> {t("graph.legendAdded")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="legend-swatch bg-rose-400" /> {t("graph.legendRemoved")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="legend-swatch bg-amber-300" /> {t("graph.legendModified")}
            </span>
          </div>
        ) : null}

        {!compact && !reviewing && Object.keys(appliedExpanded).length === 0 ? (
          <div className="glass absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-lg px-2.5 py-1.5 text-[9px] text-[var(--faint)]">
            {t("graph.clickHint")}
          </div>
        ) : null}
      </div>

      {!compact && selected && inspectorContext ? (
        <NodeInspector
          node={selected}
          onClose={() => setSelectedNode(null)}
          context={inspectorContext}
          focused={model.focus === selected.id}
          onToggleFocus={() => toggleFocus(selected.id)}
        />
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
