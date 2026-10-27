import {
  ArrowRight,
  GitPullRequest,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { isReviewing, nextOrdinal, ordinalLabel } from "../lib/utils";
import { useJin } from "../state/useJin";

export function ReviewBar() {
  const proposal = useJin((state) => state.app?.proposal ?? null);
  const snapshot = useJin((state) => state.app?.snapshot);
  const setReviewOpen = useJin((state) => state.setReviewOpen);
  const rejectProposal = useJin((state) => state.rejectProposal);
  const busy = useJin((state) => state.busy);

  if (!proposal || !isReviewing(proposal)) return null;
  const stale = proposal.status === "stale";
  const { added, removed, modified } = proposal.diff.summary;

  return (
    <div
      className={`flex shrink-0 items-center gap-3 border-b px-3 py-2 ${
        stale
          ? "border-rose-400/20 bg-rose-400/[0.045]"
          : "border-amber-300/15 bg-amber-300/[0.035]"
      }`}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel-soft)]">
        {stale ? (
          <ShieldAlert size={14} className="text-[var(--danger)]" />
        ) : (
          <GitPullRequest size={14} className="text-[var(--warning)]" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold">
            {stale ? "Architecture changed during review" : "One approval required"}
          </span>
          <span className="font-mono-ui text-[9px] text-[var(--faint)]">
            {ordinalLabel(nextOrdinal(snapshot))}
          </span>
          <span className="hidden max-w-[420px] truncate text-[10px] text-[var(--muted)] md:inline">
            {proposal.intent.title}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[8.5px] text-[var(--faint)]">
          <span className="text-[var(--success)]">+{added}</span>
          <span className="text-[var(--danger)]">−{removed}</span>
          <span className="text-[var(--warning)]">~{modified}</span>
          <span>·</span>
          <span>
            {proposal.risks.length} risk{proposal.risks.length === 1 ? "" : "s"}
          </span>
          {proposal.reusePlan ? (
            <>
              <span>·</span>
              <span>{proposal.reusePlan.candidates.length} reuse candidates</span>
            </>
          ) : null}
          {stale ? (
            <>
              <span>·</span>
              <span className="text-[var(--danger)]">
                Reject this version, then rescan to continue.
              </span>
            </>
          ) : null}
        </div>
      </div>
      <button
        className="btn h-7 px-2 text-[9px]"
        disabled={Boolean(busy)}
        onClick={() => void rejectProposal()}
      >
        <X size={11} />
        Reject
      </button>
      <button
        className="btn btn-primary h-7 px-2.5 text-[9px]"
        onClick={() => setReviewOpen(true)}
      >
        {stale ? <ShieldCheck size={11} /> : <ShieldCheck size={11} />}
        Review
        <ArrowRight size={11} />
      </button>
    </div>
  );
}
