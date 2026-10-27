import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Circle,
  Code2,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  Layers3,
  Plug,
  RotateCcw,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import type { VersionState } from "../../shared/arch/types";
import type { ProposalView } from "../../shared/ipc";
import {
  formatCount,
  formatDate,
  formatRelative,
  isReviewing,
  nextOrdinal,
  ordinalLabel,
  statusLabel,
  statusTone,
} from "../lib/utils";
import { useJin } from "../state/useJin";

function RiskList({ proposal }: { proposal: ProposalView }) {
  if (proposal.risks.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-[var(--success)]">
        <CheckCircle2 size={11} /> No architectural risks detected
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {proposal.risks.map((risk) => (
        <div
          key={risk.id}
          className={[
            "flex items-start gap-1.5 rounded-md border px-2 py-1.5",
            risk.level === "high"
              ? "border-rose-400/20 bg-rose-400/[0.05]"
              : risk.level === "medium"
                ? "border-amber-400/20 bg-amber-400/[0.05]"
                : "border-[var(--border)] bg-[var(--panel-soft)]",
          ].join(" ")}
        >
          {risk.level === "high" ? (
            <ShieldAlert size={11} className="mt-0.5 shrink-0 text-[var(--danger)]" />
          ) : (
            <AlertTriangle
              size={11}
              className={`mt-0.5 shrink-0 ${
                risk.level === "medium" ? "text-[var(--warning)]" : "text-[var(--faint)]"
              }`}
            />
          )}
          <div className="min-w-0">
            <div className="text-[10px] font-semibold leading-snug">{risk.title}</div>
            <div className="mt-0.5 text-[9px] leading-relaxed text-[var(--faint)]">
              {risk.detail}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function DiffStat({ proposal }: { proposal: ProposalView }) {
  const { added, removed, modified } = proposal.diff.summary;
  return (
    <div className="grid grid-cols-3 gap-1.5">
      <div className="inner-panel px-2 py-1.5 text-center">
        <div className="font-mono-ui text-[14px] font-bold text-[var(--success)]">+{added}</div>
        <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">added</div>
      </div>
      <div className="inner-panel px-2 py-1.5 text-center">
        <div className="font-mono-ui text-[14px] font-bold text-[var(--danger)]">−{removed}</div>
        <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">removed</div>
      </div>
      <div className="inner-panel px-2 py-1.5 text-center">
        <div className="font-mono-ui text-[14px] font-bold text-[var(--warning)]">~{modified}</div>
        <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">modified</div>
      </div>
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: ProposalView }) {
  const app = useJin((state) => state.app);
  const reviewOpen = useJin((state) => state.reviewOpen);
  const setReviewOpen = useJin((state) => state.setReviewOpen);
  const rejectProposal = useJin((state) => state.rejectProposal);
  const busy = useJin((state) => state.busy);
  const stale = proposal.status === "stale";
  const ordinal = ordinalLabel(nextOrdinal(app?.snapshot));

  return (
    <div className="inner-panel overflow-hidden border-[var(--border-strong)] bg-[var(--panel-soft)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className={`chip ${stale ? "chip-danger" : "chip-warning"}`}>
          {stale ? <XCircle size={9} /> : <GitPullRequest size={9} />}
          {stale ? "Stale review" : "In review"}
        </span>
        <span className="font-mono-ui text-[9px] text-[var(--faint)]">{ordinal}</span>
        <span className="ml-auto font-mono-ui text-[9px] text-[var(--faint)]">
          {formatRelative(proposal.createdAt)}
        </span>
      </div>
      <div className="p-3">
        <h3 className="text-[13px] leading-snug font-bold tracking-tight">
          {proposal.intent.title}
        </h3>
        <p className="mt-1.5 line-clamp-3 text-[10.5px] leading-relaxed text-[var(--muted)]">
          {proposal.intent.goal}
        </p>
        <div className="mt-3">
          <DiffStat proposal={proposal} />
        </div>
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="panel-title">Risks</span>
            <span className="chip h-[18px] px-1.5 text-[8px]">{proposal.risks.length}</span>
          </div>
          <RiskList proposal={proposal} />
        </div>
        {proposal.reusePlan ? (
          <div className="mt-3 flex items-center gap-1.5 text-[9.5px] text-[var(--faint)]">
            <Code2 size={10} />
            ReusePlan: {proposal.reusePlan.candidates.length} candidate
            {proposal.reusePlan.candidates.length === 1 ? "" : "s"}
          </div>
        ) : null}
        <div className="mt-3 flex gap-1.5">
          <button
            className="btn btn-primary flex-1"
            onClick={() => setReviewOpen(true)}
            disabled={reviewOpen}
          >
            <Layers3 size={13} />
            Review architecture
          </button>
          <button
            className="btn btn-danger"
            disabled={Boolean(busy)}
            onClick={() => void rejectProposal()}
          >
            Reject
          </button>
        </div>
        {stale ? (
          <p className="mt-2 text-[9px] leading-relaxed text-[var(--danger)]">
            The approved architecture changed underneath this review. Reject it, then scan or
            ask again to create a fresh proposal.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ImplementationChecks({ version }: { version: VersionState }) {
  const snapshot = useJin((state) => state.app?.snapshot);
  const records =
    snapshot?.implementations && version.implementations.length > 0
      ? version.implementations
          .map((id) => snapshot.implementations[id])
          .filter(Boolean)
      : [];
  const last = records[records.length - 1];
  if (!last) return null;
  const checks = last.checks ?? [];
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center gap-1.5 text-[9px] text-[var(--faint)]">
        <GitCommitHorizontal size={10} />
        Implementation {last.gitCommit || "(uncommitted)"}
      </div>
      {checks.slice(0, 4).map((check) => (
        <div key={`${last.id}:${check.name}`} className="flex items-start gap-1.5 text-[9px]">
          {check.status === "pass" ? (
            <CheckCircle2 size={10} className="mt-0.5 shrink-0 text-[var(--success)]" />
          ) : check.status === "fail" ? (
            <XCircle size={10} className="mt-0.5 shrink-0 text-[var(--danger)]" />
          ) : (
            <Circle size={10} className="mt-0.5 shrink-0 text-[var(--faint)]" />
          )}
          <span className="min-w-0 text-[var(--muted)]">
            <span className="font-semibold text-[var(--text)]">{check.name}</span>{" "}
            {check.detail}
          </span>
        </div>
      ))}
    </div>
  );
}

function VersionRow({ version, current }: { version: VersionState; current: boolean }) {
  const snapshot = useJin((state) => state.app?.snapshot);
  const app = useJin((state) => state.app);
  const busy = useJin((state) => state.busy);
  const retryImplementation = useJin((state) => state.retryImplementation);
  const intent = snapshot?.intents[version.intentId];
  const configured =
    app?.settings.provider.kind === "ollama" ||
    (app?.settings.provider.kind === "openai-compatible" &&
      app.settings.provider.hasApiKey);
  const canRetry =
    configured &&
    ["approved", "implemented", "verified"].includes(version.status) &&
    (app?.agent.phase === "idle" || app?.agent.phase === "error");
  return (
    <details className="group border-b border-[var(--border)] last:border-0">
      <summary className="hover-row flex cursor-pointer list-none items-start gap-2 px-3 py-2.5">
        <span className="font-mono-ui mt-0.5 w-7 shrink-0 text-[10px] font-bold text-[var(--accent)]">
          {version.ordinal ? `v${version.ordinal}` : "v—"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10.5px] font-semibold">
            {intent?.title ?? "Unknown intent"}
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span
              className={`chip h-[17px] px-1.5 text-[8px] ${
                statusTone(version.status) === "success"
                  ? "chip-success"
                  : statusTone(version.status) === "danger"
                    ? "chip-danger"
                    : statusTone(version.status) === "accent"
                      ? "chip-accent"
                      : ""
              }`}
            >
              {statusLabel(version.status)}
            </span>
            <span className="text-[8.5px] text-[var(--faint)]">
              {formatDate(version.updatedAt || version.createdAt)}
            </span>
            {index === 0 ? <span className="chip h-[17px] px-1.5 text-[8px]">latest</span> : null}
          </div>
        </div>
        <ChevronRight
          size={12}
          className="mt-1 shrink-0 text-[var(--faint)] transition-transform group-open:rotate-90"
        />
      </summary>
      <div className="px-3 pb-3 pl-[52px]">
        {intent?.goal ? (
          <p className="text-[9.5px] leading-relaxed text-[var(--muted)]">{intent.goal}</p>
        ) : null}
        {intent && intent.tasks.length > 0 ? (
          <div className="mt-2 space-y-1">
            {intent.tasks.slice(0, 3).map((task) => (
              <div key={task.id} className="flex items-start gap-1.5 text-[9px] text-[var(--faint)]">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[var(--faint)]" />
                <span>{task.title}</span>
              </div>
            ))}
          </div>
        ) : null}
        <ImplementationChecks version={version} />
        {canRetry ? (
          <button
            className="btn mt-2 h-7 px-2 text-[9px]"
            disabled={Boolean(busy)}
            onClick={() => void retryImplementation(version.id)}
          >
            <RotateCcw size={10} />
            {version.implementations.length > 0 ? "Re-run implementation" : "Implement version"}
          </button>
        ) : null}
      </div>
    </details>
  );
}

function HistorySection() {
  const snapshot = useJin((state) => state.app?.snapshot);
  if (!snapshot) return null;
  const versions = Object.values(snapshot.versions).sort(
    (a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0),
  );
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <History size={12} className="text-[var(--faint)]" />
        <span className="panel-title">Architecture history</span>
        <span className="chip ml-auto h-[18px] px-1.5 text-[8px]">{versions.length}</span>
      </div>
      {versions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-[9.5px] text-[var(--faint)]">
          No approved versions yet.
        </div>
      ) : (
        <div className="inner-panel overflow-hidden">
          {versions.map((version, index) => (
            <VersionRow key={version.id} version={version} index={index} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectHealth() {
  const app = useJin((state) => state.app);
  const openSettings = useJin((state) => state.openSettings);
  if (!app) return null;
  const missing = app.lsp.filter((server) => server.status === "missing");
  const warnings = [...new Set([...app.wal.warnings, ...(app.fold?.warnings ?? [])])];
  const conflicts = app.wal.conflicts;
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <Wrench size={12} className="text-[var(--faint)]" />
        <span className="panel-title">Project health</span>
      </div>

      <div className="inner-panel grid grid-cols-2 gap-px overflow-hidden bg-[var(--border)]">
        <div className="bg-[var(--panel-solid)] px-2.5 py-2">
          <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">Source files</div>
          <div className="font-mono-ui mt-0.5 text-[12px] font-bold">
            {formatCount(app.scan.files)}
          </div>
        </div>
        <div className="bg-[var(--panel-solid)] px-2.5 py-2">
          <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">Symbols</div>
          <div className="font-mono-ui mt-0.5 text-[12px] font-bold">
            {formatCount(app.scan.symbols)}
          </div>
        </div>
        <div className="bg-[var(--panel-solid)] px-2.5 py-2">
          <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">Graph edges</div>
          <div className="font-mono-ui mt-0.5 text-[12px] font-bold">
            {formatCount(app.scan.edges)}
          </div>
        </div>
        <div className="bg-[var(--panel-solid)] px-2.5 py-2">
          <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">WAL records</div>
          <div className="font-mono-ui mt-0.5 text-[12px] font-bold">
            {formatCount(app.wal.records)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-[9px] text-[var(--faint)]">
        <ScanSearch size={10} />
        {app.scan.message}
      </div>

      {conflicts.length > 0 ? (
        <button
          className="flex w-full items-start gap-2 rounded-lg border border-rose-400/25 bg-rose-400/[0.06] p-2 text-left"
          onClick={() => openSettings("team")}
        >
          <ShieldAlert size={12} className="mt-0.5 shrink-0 text-[var(--danger)]" />
          <span className="text-[9.5px] leading-relaxed text-[var(--muted)]">
            <strong className="text-[var(--danger)]">
              {conflicts.length} WAL conflict{conflicts.length === 1 ? "" : "s"}
            </strong>{" "}
            — review the merge state before continuing.
          </span>
        </button>
      ) : null}

      {warnings.length > 0 ? (
        <details className="inner-panel px-2 py-1.5">
          <summary className="cursor-pointer text-[9px] font-semibold text-[var(--warning)]">
            {warnings.length} WAL warning{warnings.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-1.5 space-y-1">
            {warnings.slice(0, 5).map((warning) => (
              <div key={warning} className="text-[8.5px] leading-relaxed text-[var(--faint)]">
                {warning}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <button
        className="hover-row flex w-full items-center gap-2 rounded-lg border border-[var(--border)] px-2 py-2 text-left"
        onClick={() => openSettings("tools")}
      >
        <Plug size={12} className="shrink-0 text-[var(--violet)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[9.5px] font-semibold">
            {missing.length > 0
              ? `${missing.length} language server${missing.length === 1 ? "" : "s"} missing`
              : "Language servers ready"}
          </div>
          <div className="mt-0.5 truncate text-[8.5px] text-[var(--faint)]">
            {app.tools.skills.length} skills · {app.tools.mcpServers.length} MCP servers
          </div>
        </div>
        <ArrowUpRight size={12} className="shrink-0 text-[var(--faint)]" />
      </button>
    </section>
  );
}

export function IntentPanel() {
  const app = useJin((state) => state.app);
  const proposal = app?.proposal ?? null;
  const reviewing = isReviewing(proposal);
  const setReviewOpen = useJin((state) => state.setReviewOpen);
  const retryImplementation = useJin((state) => state.retryImplementation);
  const agentPhase = app?.agent.phase ?? "idle";
  const providerConfigured =
    app?.settings.provider.kind === "ollama" ||
    (app?.settings.provider.kind === "openai-compatible" &&
      app.settings.provider.hasApiKey);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {proposal && reviewing ? <ProposalCard proposal={proposal} /> : null}

        {proposal && proposal.status === "approved" ? (
          <div className="inner-panel p-3">
            <div className="flex items-center gap-2">
              <ShieldCheck size={13} className="text-[var(--success)]" />
              <span className="text-[10.5px] font-bold">Latest approval</span>
              <span className="chip chip-success ml-auto h-[18px] px-1.5 text-[8px]">
                approved
              </span>
            </div>
            <div className="mt-1.5 line-clamp-2 text-[10px] text-[var(--muted)]">
              {proposal.intent.title}
            </div>
            {providerConfigured &&
            (agentPhase === "idle" || agentPhase === "error") ? (
              <button
                className="btn mt-2 h-7 w-full text-[9px]"
                onClick={() => void retryImplementation(proposal.id)}
              >
                <RotateCcw size={10} />
                Re-run implementation
              </button>
            ) : null}
          </div>
        ) : null}

        {proposal && proposal.status === "rejected" ? (
          <div className="inner-panel flex items-center gap-2 p-3">
            <XCircle size={13} className="text-[var(--danger)]" />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold">Latest proposal rejected</div>
              <div className="truncate text-[9px] text-[var(--faint)]">
                {proposal.intent.title}
              </div>
            </div>
          </div>
        ) : null}

        {!proposal || (!reviewing && proposal.status !== "approved") ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] p-4">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-[var(--accent)]" />
              <span className="text-[11px] font-bold">Start with an Intent</span>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--muted)]">
              Describe a change in the chat. Jin will propose an Intent and an architecture diff;
              code follows the approval.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1">
              <span className="chip h-[19px] text-[8px]">add a feature</span>
              <span className="chip h-[19px] text-[8px]">refactor a module</span>
              <span className="chip h-[19px] text-[8px]">fix drift</span>
            </div>
          </div>
        ) : null}

        {proposal && reviewing && proposal.reusePlan ? (
          <details className="inner-panel px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[9.5px] font-semibold text-[var(--muted)]">
              <BookOpen size={11} />
              ReusePlan · {proposal.reusePlan.candidates.length} candidates
              <ChevronRight size={11} className="ml-auto" />
            </summary>
            <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--faint)]">
              {proposal.reusePlan.summary}
            </p>
            <div className="mt-2 space-y-1">
              {proposal.reusePlan.candidates.slice(0, 5).map((candidate) => (
                <div key={`${candidate.path}:${candidate.symbol}`} className="inner-panel p-1.5">
                  <div className="font-mono-ui flex items-center gap-1 text-[8.5px] text-[var(--muted)]">
                    <Code2 size={9} />
                    <span className="truncate">{candidate.path}</span>
                  </div>
                  <div className="mt-0.5 line-clamp-1 text-[8px] text-[var(--faint)]">
                    {candidate.reason}
                  </div>
                </div>
              ))}
            </div>
            <button
              className="btn mt-2 h-7 w-full text-[9px]"
              onClick={() => setReviewOpen(true)}
            >
              Inspect in review
            </button>
          </details>
        ) : null}

        <HistorySection />
        <ProjectHealth />
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--border)] px-3 py-2 text-[8.5px] text-[var(--faint)]">
        <span className="status-dot success" />
        <span className="truncate">{app?.scan.phase === "ready" ? "facts ready" : "facts pending"}</span>
        <span className="ml-auto font-mono-ui">
          {app?.scan.updatedAt ? `updated ${formatRelative(app.scan.updatedAt)}` : "not scanned"}
        </span>
      </div>
    </div>
  );
}
