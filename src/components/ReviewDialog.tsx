import {
  AlertTriangle,
  CheckCircle2,
  GitPullRequest,
  Layers3,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { RiskHint } from "../../shared/arch/diff";
import type { ProposalView } from "../../shared/ipc";
import {
  formatRelative,
  isReviewing,
  nextOrdinal,
  ordinalLabel,
} from "../lib/utils";
import { useJin } from "../state/useJin";
import { ArchitectureCanvas } from "./ArchitectureCanvas";
import { Modal, ModalHeader, Spinner } from "./ui";

function RiskIcon({ level }: { level: RiskHint["level"] }) {
  if (level === "high") return <XCircle size={12} className="text-[var(--danger)]" />;
  if (level === "medium")
    return <AlertTriangle size={12} className="text-[var(--warning)]" />;
  return <CheckCircle2 size={12} className="text-[var(--faint)]" />;
}

function ReviewDetails({ proposal }: { proposal: ProposalView }) {
  const intent = proposal.intent;
  const nodes = intent.nodeIntents;
  const stale = proposal.status === "stale";

  return (
    <div className="space-y-4 p-4">
      {stale ? (
        <div className="rounded-lg border border-rose-400/25 bg-rose-400/[0.06] p-2.5 text-[9.5px] leading-relaxed text-[var(--muted)]">
          <strong className="text-[var(--danger)]">This review is stale.</strong> The
          approved architecture changed while you were reviewing. Reject it and create a fresh
          turn; never approve against an old target.
        </div>
      ) : null}

      <section>
        <div className="flex items-center gap-2">
          <span className="chip chip-warning">
            <GitPullRequest size={9} /> {stale ? "stale" : "in review"}
          </span>
          <span className="font-mono-ui text-[9px] text-[var(--faint)]">
            {ordinalLabel(nextOrdinal(proposal.baseSnapshot))}
          </span>
          <span className="ml-auto text-[8.5px] text-[var(--faint)]">
            {formatRelative(proposal.createdAt)}
          </span>
        </div>
        <h3 className="mt-2.5 text-[16px] leading-tight font-bold tracking-tight">
          {intent.title}
        </h3>
        <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--muted)]">
          {intent.goal}
        </p>
      </section>

      <div className="grid grid-cols-3 gap-1.5">
        <div className="inner-panel px-2 py-1.5 text-center">
          <div className="font-mono-ui text-[15px] font-bold text-[var(--success)]">
            +{proposal.diff.summary.added}
          </div>
          <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">added</div>
        </div>
        <div className="inner-panel px-2 py-1.5 text-center">
          <div className="font-mono-ui text-[15px] font-bold text-[var(--danger)]">
            −{proposal.diff.summary.removed}
          </div>
          <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">removed</div>
        </div>
        <div className="inner-panel px-2 py-1.5 text-center">
          <div className="font-mono-ui text-[15px] font-bold text-[var(--warning)]">
            ~{proposal.diff.summary.modified}
          </div>
          <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">modified</div>
        </div>
      </div>

      <section>
        <div className="panel-title mb-2">Tasks</div>
        <div className="space-y-1.5">
          {intent.tasks.map((task) => (
            <div key={task.id} className="inner-panel flex items-start gap-2 p-2">
              <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[7px] text-[var(--faint)]">
                {task.status === "done" ? "✓" : ""}
              </span>
              <div className="min-w-0">
                <div className="text-[10px] font-semibold leading-snug">{task.title}</div>
                {task.acceptance.length > 0 ? (
                  <div className="mt-1 space-y-0.5">
                    {task.acceptance.map((item) => (
                      <div
                        key={item}
                        className="flex items-start gap-1 text-[8.5px] leading-relaxed text-[var(--faint)]"
                      >
                        <span className="mt-1 h-0.5 w-0.5 shrink-0 rounded-full bg-[var(--faint)]" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="panel-title mb-2">
          Node intents <span className="text-[var(--faint)]">({nodes.length})</span>
        </div>
        {nodes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2.5 text-[9px] leading-relaxed text-[var(--faint)]">
            This turn is structural only. The diff changes the approved graph, and no extra
            node-level intent is attached.
          </div>
        ) : (
          <div className="space-y-1.5">
            {nodes.map((nodeIntent) => {
              const target =
                proposal.targetSnapshot.nodes[nodeIntent.facetId ?? nodeIntent.nodeId] ??
                proposal.baseSnapshot.nodes[nodeIntent.facetId ?? nodeIntent.nodeId];
              return (
                <div
                  key={`${nodeIntent.nodeId}:${nodeIntent.facetId ?? ""}`}
                  className="inner-panel p-2"
                >
                  <div className="font-mono-ui truncate text-[9px] font-semibold text-[var(--accent)]">
                    {target?.name ?? nodeIntent.nodeId}
                  </div>
                  <div className="mt-1 text-[9.5px] leading-relaxed text-[var(--muted)]">
                    {nodeIntent.statement}
                  </div>
                  {nodeIntent.invariants.length > 0 ? (
                    <div className="mt-1.5 space-y-0.5">
                      {nodeIntent.invariants.map((invariant) => (
                        <div
                          key={invariant}
                          className="flex items-start gap-1 text-[8.5px] text-[var(--faint)]"
                        >
                          <ShieldCheck size={8} className="mt-0.5 shrink-0" />
                          <span>{invariant}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <span className="panel-title">Risks</span>
          <span className="chip h-[18px] px-1.5 text-[8px]">{proposal.risks.length}</span>
        </div>
        {proposal.risks.length === 0 ? (
          <div className="flex items-center gap-1.5 text-[9px] text-[var(--success)]">
            <CheckCircle2 size={11} /> No architecture risks detected.
          </div>
        ) : (
          <div className="space-y-1.5">
            {proposal.risks.map((risk) => (
              <div key={risk.id} className="inner-panel p-2">
                <div className="flex items-start gap-1.5">
                  <RiskIcon level={risk.level} />
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold leading-snug">{risk.title}</div>
                    <div className="mt-0.5 text-[9px] leading-relaxed text-[var(--faint)]">
                      {risk.detail}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {proposal.reusePlan ? (
        <section>
          <div className="panel-title mb-2">
            ReusePlan · {proposal.reusePlan.candidates.length} candidate
            {proposal.reusePlan.candidates.length === 1 ? "" : "s"}
          </div>
          <p className="text-[9px] leading-relaxed text-[var(--faint)]">
            {proposal.reusePlan.summary}
          </p>
          <div className="mt-2 space-y-1">
            {proposal.reusePlan.candidates.slice(0, 6).map((candidate) => (
              <div
                key={`${candidate.path}:${candidate.symbol}`}
                className="inner-panel flex items-start gap-2 p-2"
              >
                <Layers3 size={11} className="mt-0.5 shrink-0 text-[var(--violet)]" />
                <div className="min-w-0">
                  <div className="font-mono-ui truncate text-[9px] text-[var(--muted)]">
                    {candidate.path}
                  </div>
                  <div className="mt-0.5 text-[8.5px] leading-relaxed text-[var(--faint)]">
                    {candidate.reason}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] p-2 text-[8.5px] leading-relaxed text-[var(--faint)]">
        Approval binds the Intent, architecture ops, and touches by{" "}
        <span className="font-mono-ui text-[var(--muted)]">
          {proposal.diffHash.slice(0, 12)}…
        </span>
        . No code diff is part of this decision.
      </div>
    </div>
  );
}

export function ReviewDialog() {
  const open = useJin((state) => state.reviewOpen);
  const proposal = useJin((state) => state.app?.proposal ?? null);
  const busy = useJin((state) => state.busy);
  const setReviewOpen = useJin((state) => state.setReviewOpen);
  const approveProposal = useJin((state) => state.approveProposal);
  const rejectProposal = useJin((state) => state.rejectProposal);
  const [note, setNote] = useState("");

  const reviewing = isReviewing(proposal);
  const stale = proposal?.status === "stale";
  const canApprove = Boolean(proposal && reviewing && !stale);

  const close = (): void => setReviewOpen(false);

  return (
    <Modal
      open={open && Boolean(proposal)}
      onClose={close}
      className="review-modal"
      label="Architecture review"
    >
      {proposal ? (
        <>
          <ModalHeader
            title="Architecture review"
            subtitle="Intent, graph diff, and risks. Never a code diff."
            onClose={close}
            icon={<Layers3 size={16} />}
          >
            <span className="chip chip-accent">
              {ordinalLabel(nextOrdinal(proposal.baseSnapshot))} pending approval
            </span>
          </ModalHeader>

          <div className="review-grid min-h-0 flex-1">
            <div className="modal-sidebar min-h-0 overflow-y-auto">
              <ReviewDetails proposal={proposal} />
            </div>
            <div className="min-h-0 bg-[var(--panel-soft)]">
              <ArchitectureCanvas compact />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-soft)] px-4 py-3">
            <div className="hidden text-[8.5px] leading-relaxed text-[var(--faint)] lg:block">
              One approval applies the WAL bundle and starts implementation.
              <br />
              Rejected versions remain in history and are never applied.
            </div>
            <input
              className="field ml-auto h-8 w-[210px] text-[10px]"
              placeholder="Optional review note…"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={Boolean(busy)}
            />
            <button
              className="btn h-8"
              disabled={Boolean(busy)}
              onClick={() => void rejectProposal(note.trim() || undefined)}
            >
              <X size={12} />
              Reject
            </button>
            <button
              className="btn btn-primary h-8 px-4"
              disabled={!canApprove || Boolean(busy)}
              onClick={() => void approveProposal(note.trim() || undefined)}
              title={
                stale
                  ? "Reject this stale review, then rescan"
                  : "Approve the Intent and architecture diff"
              }
            >
              {busy === "Applying approval…" ? (
                <Spinner size={12} />
              ) : (
                <ShieldCheck size={13} />
              )}
              Approve & implement
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
