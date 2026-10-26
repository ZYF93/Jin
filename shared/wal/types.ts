import type {
  Actor,
  ArchOp,
  Decision,
  FoldResult,
  ImplementationRecord,
  Intent,
  Touch,
} from "../arch/types";

/**
 * WAL record types.
 *
 * A record is content-addressed. `parents` describe causal ancestry and are
 * the only thing that makes two independently appended log files mergeable.
 */
export interface WalRecordBase {
  id: string;
  versionId: string;
  actor: Actor;
  /** Hybrid logical clock, formatted as wall:counter:actor. */
  hlc: string;
  parents: string[];
  hash: string;
}

export interface IntentWalRecord extends WalRecordBase {
  t: "intent";
  payload: Intent;
}

export interface OpWalRecord extends WalRecordBase {
  t: "op";
  payload: ArchOp;
}

export interface TouchWalRecord extends WalRecordBase {
  t: "touch";
  payload: Touch;
}

export interface DecisionWalRecord extends WalRecordBase {
  t: "decision";
  payload: Decision;
}

export interface ImplementationWalRecord extends WalRecordBase {
  t: "implementation";
  payload: ImplementationRecord;
}

export type WalRecord =
  | IntentWalRecord
  | OpWalRecord
  | TouchWalRecord
  | DecisionWalRecord
  | ImplementationWalRecord;

export type WalRecordType = WalRecord["t"];

export type WalRecordDraft =
  | Omit<IntentWalRecord, "hash">
  | Omit<OpWalRecord, "hash">
  | Omit<TouchWalRecord, "hash">
  | Omit<DecisionWalRecord, "hash">
  | Omit<ImplementationWalRecord, "hash">;

export interface WalParseError {
  line: number;
  message: string;
}

export interface WalParseResult {
  records: WalRecord[];
  errors: WalParseError[];
}

export interface WalMergeResult extends FoldResult {
  /** Deterministic merged JSONL, ready to write to the merge-driver output. */
  text: string;
  records: WalRecord[];
  parseErrors: WalParseError[];
}
