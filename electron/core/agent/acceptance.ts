import type {
  ArchOp,
  ArchSnapshot,
  ImplementationCheck,
  Intent,
} from "../../../shared/ledger/types";
import type { StagedFileEdit } from "./file-transaction";
import type { ProviderConfig, ProviderTokenUsage } from "./provider";
import { completeJson } from "./provider";

export interface AcceptanceResult {
  index: number;
  status: "pass" | "fail";
  evidence: string;
}

export function validateAcceptanceResults(
  criteria: readonly string[],
  value: unknown,
): ImplementationCheck {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const rawResults = Array.isArray(record.results) ? record.results : [];
  const byIndex = new Map<number, AcceptanceResult>();
  for (const raw of rawResults) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (
      Number.isInteger(item.index) &&
      typeof item.status === "string" &&
      (item.status === "pass" || item.status === "fail") &&
      typeof item.evidence === "string"
    ) {
      byIndex.set(item.index as number, {
        index: item.index as number,
        status: item.status,
        evidence: item.evidence.trim(),
      });
    }
  }
  const missing: number[] = [];
  const failed: string[] = [];
  criteria.forEach((criterion, index) => {
    const result = byIndex.get(index);
    if (!result || !result.evidence) missing.push(index + 1);
    else if (result.status !== "pass")
      failed.push(`${index + 1}. ${criterion}: ${result.evidence}`);
  });
  if (rawResults.length !== criteria.length || missing.length > 0) {
    return {
      name: "proposal acceptance",
      status: "fail",
      detail: `Acceptance review was incomplete; missing or malformed results for criteria ${missing.join(", ") || "count mismatch"}.`,
    };
  }
  return {
    name: "proposal acceptance",
    status: failed.length === 0 ? "pass" : "fail",
    detail:
      failed.length === 0
        ? `${criteria.length} approved acceptance criteria passed review.`
        : failed.join("\n"),
  };
}

function acceptanceCriteria(intent: Intent): string[] {
  const criteria = [
    ...intent.tasks.flatMap((task) =>
      task.acceptance.map((item) => `Task “${task.title}”: ${item}`),
    ),
    ...intent.nodeIntents.flatMap((node) => [
      ...node.invariants.map((item) => `Invariant for ${node.nodeId}: ${item}`),
      ...node.acceptance.map((item) => `Node ${node.nodeId}: ${item}`),
    ]),
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(criteria)];
}

export async function reviewProposalAcceptance(input: {
  provider: ProviderConfig;
  intent: Intent;
  ops: readonly ArchOp[];
  snapshot: ArchSnapshot;
  edits: readonly StagedFileEdit[];
  signal: AbortSignal;
  onUsage?: (usage: ProviderTokenUsage) => void;
}): Promise<ImplementationCheck> {
  const criteria = acceptanceCriteria(input.intent);
  if (criteria.length === 0) {
    return {
      name: "proposal acceptance",
      status: "fail",
      detail: "The approved proposal contains no verifiable acceptance criteria.",
    };
  }
  const paths = new Set(input.edits.map((edit) => edit.path));
  const nodes = Object.values(input.snapshot.nodes)
    .filter((node) => node.file && paths.has(node.file))
    .map((node) => ({
      id: node.id,
      level: node.level,
      kind: node.kind,
      name: node.name,
      file: node.file,
      responsibility: node.responsibility,
    }));
  const files = input.edits.map((edit) => ({
    path: edit.path,
    before: edit.originalExists ? edit.originalContent.slice(0, 12_000) : "(new file)",
    after: edit.content === null ? "(deleted)" : edit.content.slice(0, 12_000),
  }));
  const system = `You are an independent acceptance reviewer for an architecture-first coding workflow.
Compare the proposed source edits against every approved criterion. Use only the supplied proposal and code. Mark a criterion pass only when the code shown provides concrete evidence; otherwise mark it fail. Do not infer behavior from file names or summaries. Return JSON only with exactly one result for each zero-based criterion index: {"results":[{"index":0,"status":"pass","evidence":"..."}]}.`;
  const review = await completeJson(
    input.provider,
    system,
    JSON.stringify(
      {
        intent: { title: input.intent.title, goal: input.intent.goal },
        criteria,
        approvedOps: input.ops,
        approvedNodes: nodes,
        edits: files,
      },
      null,
      2,
    ),
    {
      temperature: 0,
      maxTokens: 6_000,
      json: true,
      signal: input.signal,
      onUsage: input.onUsage,
    },
  );
  return validateAcceptanceResults(criteria, review);
}
