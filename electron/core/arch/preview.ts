import type { ArchOp, ArchSnapshot } from "../../../shared/arch/types";
import type { RiskHint } from "../../../shared/arch/diff";
import { diffSnapshots, riskHints } from "./diff";
import { applyOp, cloneSnapshot } from "./snapshot";

export interface PreviewResult {
  snapshot: ArchSnapshot;
  conflicts: string[];
}

/** Apply proposed ops to a clone without touching the approved snapshot. */
export function previewOps(
  base: ArchSnapshot,
  ops: readonly ArchOp[],
  versionId: string,
): PreviewResult {
  const snapshot = cloneSnapshot(base);
  const conflicts: string[] = [];
  for (const op of ops) {
    const conflict = applyOp(snapshot, op, versionId, "");
    if (conflict) conflicts.push(conflict.message);
  }
  return { snapshot, conflicts };
}

export interface ProposalPreview {
  target: ArchSnapshot;
  risks: RiskHint[];
  conflicts: string[];
}

export function previewProposal(
  base: ArchSnapshot,
  ops: readonly ArchOp[],
  versionId: string,
): ProposalPreview {
  const preview = previewOps(base, ops, versionId);
  const diff = diffSnapshots(base, preview.snapshot);
  return {
    target: preview.snapshot,
    risks: riskHints(base, preview.snapshot, diff),
    conflicts: preview.conflicts,
  };
}
