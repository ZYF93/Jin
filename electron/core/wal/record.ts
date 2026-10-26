import { hashValue, isSha256 } from "../hash/canonical";
import { isUlid } from "../ids/ulid";
import { parseHlc } from "../time/hlc";
import type { Actor, ArchOp, Intent, NodeKind, NodeLevel, EdgeKind, Decision, ImplementationRecord, Touch } from "../../../shared/arch/types";
import type { WalRecord, WalRecordDraft, WalRecordType } from "../../../shared/wal/types";

const RECORD_TYPES: ReadonlySet<string> = new Set<WalRecordType>([
  "intent",
  "op",
  "touch",
  "decision",
  "implementation",
]);

const NODE_LEVELS: ReadonlySet<string> = new Set<NodeLevel>(["L0", "L1", "facet"]);
const NODE_KINDS: ReadonlySet<string> = new Set<NodeKind>([
  "system",
  "domain",
  "module",
  "layer",
  "external",
  "component",
  "hook",
  "entity",
  "service",
  "repository",
  "route",
  "store",
  "type",
  "function",
  "table",
  "schema",
  "config",
  "method",
  "field",
  "property",
]);
const EDGE_KINDS: ReadonlySet<string> = new Set<EdgeKind>([
  "contains",
  "depends_on",
  "uses",
  "implements",
  "extends",
  "references",
  "renders",
  "reads",
  "writes",
  "constrains",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function sortParents(parents: readonly string[]): string[] {
  return [...new Set(parents)].sort();
}

/** Hash a record without its `hash` field. Parents are canonicalized. */
export function hashRecord(record: WalRecord): string {
  const copy: Record<string, unknown> = { ...record };
  delete copy.hash;
  return hashValue({ ...copy, parents: sortParents(record.parents) });
}

/**
 * Fill in the content hash of a draft record. The caller owns id/hlc/parents;
 * this function only guarantees deterministic parent ordering and hashing.
 */
export function sealRecord<T extends WalRecordDraft>(
  draft: T,
): T & { parents: string[]; hash: string } {
  const parents = sortParents(draft.parents);
  const hash = hashValue({ ...draft, parents });
  return { ...draft, parents, hash };
}

function validateActor(value: unknown): string[] {
  if (!isObject(value)) return ["actor must be an object"];
  const issues: string[] = [];
  if (!isNonEmptyString(value.id)) issues.push("actor.id is required");
  if (value.kind !== "user" && value.kind !== "agent" && value.kind !== "system") {
    issues.push("actor.kind must be user, agent, or system");
  }
  if (!isNonEmptyString(value.name)) issues.push("actor.name is required");
  return issues;
}

function validateIntent(payload: unknown, versionId: string): string[] {
  if (!isObject(payload)) return ["intent payload must be an object"];
  const issues: string[] = [];
  if (!isUlid(payload.id)) issues.push("intent.id must be a ULID");
  if (payload.versionId !== versionId) issues.push("intent.versionId must match record.versionId");
  if (!isNonEmptyString(payload.title)) issues.push("intent.title is required");
  if (!isNonEmptyString(payload.goal)) issues.push("intent.goal is required");
  if (!Array.isArray(payload.tasks)) issues.push("intent.tasks must be an array");
  if (!Array.isArray(payload.nodeIntents)) issues.push("intent.nodeIntents must be an array");
  return issues;
}

function validateOp(payload: unknown): string[] {
  if (!isObject(payload)) return ["op payload must be an object"];
  const issues: string[] = [];
  const op = payload.op;
  if (op === "node.add") {
    if (!isObject(payload.node)) return ["node.add requires node"];
    const node = payload.node;
    if (!isUlid(node.id)) issues.push("node.add node.id must be a ULID");
    if (!NODE_LEVELS.has(String(node.level))) issues.push("node.add node.level is invalid");
    if (!NODE_KINDS.has(String(node.kind))) issues.push("node.add node.kind is invalid");
    if (!isNonEmptyString(node.name)) issues.push("node.add node.name is required");
    if (node.parentId !== null && !isUlid(node.parentId)) issues.push("node.add node.parentId must be a ULID or null");
    if (node.intentId !== null && !isUlid(node.intentId)) issues.push("node.add node.intentId must be a ULID or null");
    if (node.status !== "active" && node.status !== "planned" && node.status !== "deprecated") {
      issues.push("node.add node.status is invalid");
    }
    if (!isObject(node.metadata)) issues.push("node.add node.metadata must be an object");
  } else if (op === "node.update") {
    if (!isUlid(payload.id)) issues.push("node.update id must be a ULID");
    if (!isSha256(payload.beforeHash)) issues.push("node.update beforeHash must be a sha256 hash");
    if (!isObject(payload.patch)) issues.push("node.update patch must be an object");
  } else if (op === "node.remove") {
    if (!isUlid(payload.id)) issues.push("node.remove id must be a ULID");
    if (!isSha256(payload.beforeHash)) issues.push("node.remove beforeHash must be a sha256 hash");
  } else if (op === "edge.add") {
    if (!isObject(payload.edge)) return ["edge.add requires edge"];
    const edge = payload.edge;
    if (!isUlid(edge.id)) issues.push("edge.add edge.id must be a ULID");
    if (!isUlid(edge.from)) issues.push("edge.add edge.from must be a ULID");
    if (!isUlid(edge.to)) issues.push("edge.add edge.to must be a ULID");
    if (!EDGE_KINDS.has(String(edge.kind))) issues.push("edge.add edge.kind is invalid");
    if (!isObject(edge.metadata)) issues.push("edge.add edge.metadata must be an object");
  } else if (op === "edge.remove") {
    if (!isUlid(payload.id)) issues.push("edge.remove id must be a ULID");
    if (!isSha256(payload.beforeHash)) issues.push("edge.remove beforeHash must be a sha256 hash");
  } else {
    issues.push("op must be node.add, node.update, node.remove, edge.add, or edge.remove");
  }
  return issues;
}

function validateTouch(payload: unknown, versionId: string): string[] {
  if (!isObject(payload)) return ["touch payload must be an object"];
  const issues: string[] = [];
  if (payload.versionId !== versionId) issues.push("touch.versionId must match record.versionId");
  if (!isUlid(payload.id)) issues.push("touch.id must be a ULID");
  if (!isUlid(payload.intentId)) issues.push("touch.intentId must be a ULID");
  if (!isUlid(payload.nodeId)) issues.push("touch.nodeId must be a ULID");
  if (payload.facetId !== null && !isUlid(payload.facetId)) issues.push("touch.facetId must be a ULID or null");
  if (!isNonEmptyString(payload.reason)) issues.push("touch.reason is required");
  if (!Array.isArray(payload.codeRefs)) issues.push("touch.codeRefs must be an array");
  if (!Array.isArray(payload.tests)) issues.push("touch.tests must be an array");
  return issues;
}

function validateDecision(payload: unknown, versionId: string): string[] {
  if (!isObject(payload)) return ["decision payload must be an object"];
  const issues: string[] = [];
  if (payload.versionId !== versionId) issues.push("decision.versionId must match record.versionId");
  if (!isUlid(payload.id)) issues.push("decision.id must be a ULID");
  if (payload.decision !== "approved" && payload.decision !== "rejected") {
    issues.push("decision.decision must be approved or rejected");
  }
  if (!isSha256(payload.baseHash)) issues.push("decision.baseHash must be a sha256 hash");
  if (!isSha256(payload.targetHash)) issues.push("decision.targetHash must be a sha256 hash");
  if (payload.diffHash !== undefined && !isSha256(payload.diffHash)) {
    issues.push("decision.diffHash must be a sha256 hash");
  }
  if (!isNonEmptyString(payload.signature)) issues.push("decision.signature is required");
  return issues;
}

function validateImplementation(payload: unknown, versionId: string): string[] {
  if (!isObject(payload)) return ["implementation payload must be an object"];
  const issues: string[] = [];
  if (payload.versionId !== versionId) issues.push("implementation.versionId must match record.versionId");
  if (!isUlid(payload.id)) issues.push("implementation.id must be a ULID");
  if (!isNonEmptyString(payload.gitCommit)) issues.push("implementation.gitCommit is required");
  if (!Array.isArray(payload.files)) issues.push("implementation.files must be an array");
  if (!Array.isArray(payload.checks)) issues.push("implementation.checks must be an array");
  if (!Array.isArray(payload.conformance)) issues.push("implementation.conformance must be an array");
  return issues;
}

/**
 * Validate shape, ULIDs, HLC, and the content hash. Returns human-readable
 * issues; an empty array means the record is safe to apply.
 */
export function validateRecord(value: unknown): string[] {
  if (!isObject(value)) return ["record must be an object"];
  const issues: string[] = [];

  if (!RECORD_TYPES.has(String(value.t))) issues.push("unknown record type");
  if (!isUlid(value.id)) issues.push("id must be a ULID");
  if (!isUlid(value.versionId)) issues.push("versionId must be a ULID");
  issues.push(...validateActor(value.actor));

  if (typeof value.hlc !== "string") {
    issues.push("hlc is required");
  } else {
    try {
      parseHlc(value.hlc);
    } catch {
      issues.push("hlc is malformed");
    }
  }

  if (!Array.isArray(value.parents)) {
    issues.push("parents must be an array");
  } else {
    for (const parent of value.parents) {
      if (!isUlid(parent)) issues.push("every parent must be a ULID");
    }
  }

  if (!isSha256(value.hash)) issues.push("hash must be a sha256 hash");

  if (value.t === "intent") issues.push(...validateIntent(value.payload, String(value.versionId)));
  if (value.t === "op") issues.push(...validateOp(value.payload));
  if (value.t === "touch") issues.push(...validateTouch(value.payload, String(value.versionId)));
  if (value.t === "decision") issues.push(...validateDecision(value.payload, String(value.versionId)));
  if (value.t === "implementation") {
    issues.push(...validateImplementation(value.payload, String(value.versionId)));
  }

  if (issues.length === 0) {
    const expected = hashRecord(value as unknown as WalRecord);
    if (value.hash !== expected) issues.push("hash does not match record content");
  }

  return issues;
}

export function isWalRecord(value: unknown): value is WalRecord {
  return validateRecord(value).length === 0;
}

export function serializeRecord(record: WalRecord): string {
  return JSON.stringify(record);
}

/**
 * Parse and validate one JSONL line. Throws with line context on failure.
 */
export function parseRecordLine(line: string, lineNumber: number): WalRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`line ${lineNumber}: invalid JSON`);
  }
  const issues = validateRecord(value);
  if (issues.length > 0) {
    throw new Error(`line ${lineNumber}: ${issues.join("; ")}`);
  }
  return value as WalRecord;
}

/** Convenience for tests and the future WAL writer. */
export function makeIntentRecord(
  base: Omit<WalRecordDraft, "t" | "payload">,
  payload: Intent,
): ReturnType<typeof sealRecord> {
  return sealRecord({ ...base, t: "intent", payload });
}

export function makeOpRecord(
  base: Omit<WalRecordDraft, "t" | "payload">,
  payload: ArchOp,
): ReturnType<typeof sealRecord> {
  return sealRecord({ ...base, t: "op", payload });
}

export function makeTouchRecord(
  base: Omit<WalRecordDraft, "t" | "payload">,
  payload: Touch,
): ReturnType<typeof sealRecord> {
  return sealRecord({ ...base, t: "touch", payload });
}

export function makeDecisionRecord(
  base: Omit<WalRecordDraft, "t" | "payload">,
  payload: Decision,
): ReturnType<typeof sealRecord> {
  return sealRecord({ ...base, t: "decision", payload });
}

export function makeImplementationRecord(
  base: Omit<WalRecordDraft, "t" | "payload">,
  payload: ImplementationRecord,
): ReturnType<typeof sealRecord> {
  return sealRecord({ ...base, t: "implementation", payload });
}

export type RecordBase = {
  id: string;
  versionId: string;
  actor: Actor;
  hlc: string;
  parents: string[];
};
