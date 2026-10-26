import { createHash } from "node:crypto";

/**
 * Deterministic JSON for hashing. Object keys are sorted; array order is
 * preserved; `undefined` object fields are omitted and `undefined` array items
 * become `null` (matching JSON.stringify).
 */
export function canonicalize(value: unknown): string {
  if (value === undefined || value === null) return "null";

  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new TypeError("Cannot canonicalize a bigint");
  }
  if (typeof value !== "object") {
    throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const fields = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`,
  );
  return `{${fields.join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Returns `sha256:<hex>`, the only hash format used by the WAL. */
export function hashValue(value: unknown): string {
  return `sha256:${sha256(canonicalize(value))}`;
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
