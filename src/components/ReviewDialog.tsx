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
import { useT } from "../lib/i18n";
import {
  formatRelative,
  isReviewing,
  localizeReuseReason,
  localizeReuseSummary,
  nextOrdinal,
  ordinalLabel,
  riskText,
} from "../lib/utils";
import { useJin } from "../state/useJin";
import { ArchitectureCanvas } from "./ArchitectureCanvas";
import { Modal, ModalHeader, Spinner } from "./ui";

function RiskIcon({ level }: { level: RiskHint["level"] }) {
  if (level === "high") return <XCircle size={12} className="text-[var(--danger)]" />;
  if (level === "medium") return <AlertTriangle size={12} className="text-[var(--warning)]" />;
  return <CheckCircle2 size={12} className="text-[var(--faint)]" />;
}

function ApprovalFlow({ architectureOnly }: { architectureOnly: boolean }) {
  const t = useT();
  const steps = [
    { label: t("approvalFlow.proposal"), state: "done" },
    { label: t("approvalFlow.approval"), state: "current" },
    ...(architectureOnly
      ? [{ label: t("approvalFlow.graphOnly"), state: "pending" as const }]
      : [
          { label: t("approvalFlow.implementation"), state: "pending" as const },
          { label: t("approvalFlow.verification"), state: "pending" as const },
        ]),
  ] as const;

  return (
    <ol
      className={`grid shrink-0 gap-1 border-b border-[var(--border)] px-4 py-2.5 ${
        architectureOnly ? "grid-cols-3" : "grid-cols-4"
      }`}
      aria-label={t("approvalFlow.title")}
    >
      {steps.map((step, index) => (
        <li key={step.label} className="flex min-w-0 items-center gap-1.5">
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[8px] ${
              step.state === "done"
                ? "border-emerald-400/30 bg-emerald-400/10 text-[var(--success)]"
                : step.state === "current"
                  ? "border-amber-300/35 bg-amber-300/10 text-[var(--warning)]"
                  : "border-[var(--border)] text-[var(--faint)]"
            }`}
          >
            {step.state === "done" ? <CheckCircle2 size={11} /> : index + 1}
          </span>
          <span
            className={`min-w-0 truncate text-[8px] ${
              step.state === "current" ? "font-semibold text-[var(--text)]" : "text-[var(--faint)]"
            }`}
          >
            {step.label}
          </span>
          {index < steps.length - 1 ? (
            <span className="ml-auto h-px min-w-1 flex-1 bg-[var(--border)]" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function ReviewDetails({ proposal }: { proposal: ProposalView }) {
  const t = useT();
  const intent = proposal.intent;
  const nodes = intent.nodeIntents;
  const stale = proposal.status === "stale";

  return (
    <div className="space-y-4 p-4">
      {stale ? (
        <div className="rounded-lg border border-rose-400/25 bg-rose-400/[0.06] p-2.5 text-[9.5px] leading-relaxed text-[var(--muted)]">
          <strong className="text-[var(--danger)]">{t("review.staleBannerStrong")}</strong>{" "}
          {t("review.staleBanner")}
        </div>
      ) : null}

      <section>
        <div className="flex items-center gap-2">
          <span className="chip chip-warning">
            <GitPullRequest size={9} /> {stale ? t("review.stale") : t("review.inReview")}
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
        <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--muted)]">{intent.goal}</p>
      </section>

      <div className="grid grid-cols-3 gap-1.5">
        <div className="inner-panel px-2 py-1.5 text-center">
          <div className="font-mono-ui text-[15px] font-bold text-[var(--success)]">
            +{proposal.diff.summary.added}
          </div>
          <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">
            {t("review.added")}
          </div>
        </div>
        <div className="inner-panel px-2 py-1.5 text-center">
          <div className="font-mono-ui text-[15px] font-bold text-[var(--danger)]">
            −{proposal.diff.summary.removed}
          </div>
          <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">
            {t("review.removed")}
          </div>
        </div>
        <div className="inner-panel px-2 py-1.5 text-center">
          <div className="font-mono-ui text-[15px] font-bold text-[var(--warning)]">
            ~{proposal.diff.summary.modified}
          </div>
          <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">
            {t("review.modified")}
          </div>
        </div>
      </div>

      <section>
        <div className="panel-title mb-2">{t("review.tasks")}</div>
        <div className="space-y-1.5">
          {intent.tasks.map((task) => (
            <div key={task.id} className="inner-panel flex items-start gap-2 p-2">
              <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[7px] text-[var(--faint)]">
                {task.status === "done" ? "✓" : ""}
              </span>
              <div className="min-w-0">
                <div className="text-[10px] font-semibold leading-snug">{task.title}</div>
                {task.files?.length ? (
                  <div className="mt-1 text-[8px] leading-relaxed text-[var(--muted)]">
                    {t("common.files")}: {task.files.join(", ")}
                  </div>
                ) : null}
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
          {t("review.nodeIntents")} <span className="text-[var(--faint)]">({nodes.length})</span>
        </div>
        {nodes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2.5 text-[9px] leading-relaxed text-[var(--faint)]">
            {t("review.structuralOnly")}
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
          <span className="panel-title">{t("review.risks")}</span>
          <span className="chip h-[18px] px-1.5 text-[8px]">{proposal.risks.length}</span>
        </div>
        {proposal.risks.length === 0 ? (
          <div className="flex items-center gap-1.5 text-[9px] text-[var(--success)]">
            <CheckCircle2 size={11} /> {t("review.noRisks")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {proposal.risks.map((risk) => {
              const copy = riskText(risk, proposal.diff, t);
              return (
                <div key={risk.id} className="inner-panel p-2">
                  <div className="flex items-start gap-1.5">
                    <RiskIcon level={risk.level} />
                    <div className="min-w-0">
                      <div className="text-[10px] font-semibold leading-snug">{copy.title}</div>
                      <div className="mt-0.5 text-[9px] leading-relaxed text-[var(--faint)]">
                        {copy.detail}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {proposal.reusePlan ? (
        <section>
          <div className="panel-title mb-2">
            {t("review.reusePlan", {
              count: proposal.reusePlan.candidates.length,
            })}
          </div>
          <p className="text-[9px] leading-relaxed text-[var(--faint)]">
            {localizeReuseSummary(proposal.reusePlan.summary, t)}
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
                    {localizeReuseReason(candidate.reason, t)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] p-2 text-[8.5px] leading-relaxed text-[var(--faint)]">
        {t("review.binds", { hash: proposal.diffHash.slice(0, 12) })}
      </div>
    </div>
  );
}

export function ReviewDialog() {
  const t = useT();
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
      label={t("review.title")}
    >
      {proposal ? (
        <>
          <ModalHeader
            title={t("review.title")}
            subtitle={t("review.subtitle")}
            onClose={close}
            icon={<Layers3 size={16} />}
          >
            <span className="chip chip-accent">
              {t("review.pending", {
                ordinal: ordinalLabel(nextOrdinal(proposal.baseSnapshot)),
              })}
            </span>
          </ModalHeader>

          <ApprovalFlow architectureOnly={proposal.architectureOnly} />

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
              {proposal.architectureOnly
                ? t("review.architectureOnly")
                : t("review.startsImplementation")}
              <br />
              {t("review.rejectedHistory")}
            </div>
            <input
              className="field ml-auto h-8 w-[210px] text-[10px]"
              placeholder={t("review.notePlaceholder")}
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
              {t("common.reject")}
            </button>
            <button
              className="btn btn-primary h-8 px-4"
              disabled={!canApprove || Boolean(busy)}
              onClick={() => void approveProposal(note.trim() || undefined)}
              title={
                stale
                  ? t("review.staleApproveHint")
                  : proposal.architectureOnly
                    ? t("review.approveArchitectureHint")
                    : t("review.approveHint")
              }
            >
              {busy === t("busy.approving") ? <Spinner size={12} /> : <ShieldCheck size={13} />}
              {proposal.architectureOnly
                ? t("review.approveArchitecture")
                : t("review.approveImplement")}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
