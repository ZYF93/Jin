import { createHash } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Derive a stable 26-character Crockford id from a seed.
 *
 * The first character is fixed to `0`, which keeps the value inside the
 * canonical ULID alphabet and avoids pretending this is a sortable timestamp.
 * Architecture node/edge ids must survive a rescan, so they are derived from
 * identity (path, symbol, relationship), never generated randomly.
 */
export function stableId(seed: string): string {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  let out = "0";
  for (let index = 0; index < 25; index += 1) {
    const byte = digest[index] ?? 0;
    out += ENCODING[byte % 32];
  }
  return out;
}

export function isStableId(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}

export const stableIds = {
  system: (name: string) => stableId(`jin:system:${name}`),
  node: (kind: string, key: string) => stableId(`jin:node:${kind}:${key}`),
  edge: (from: string, kind: string, to: string, ordinal = 0) =>
    stableId(`jin:edge:${from}:${kind}:${to}:${ordinal}`),
  facet: (parentId: string, member: string) =>
    stableId(`jin:facet:${parentId}:${member}`),
  proposal: (versionId: string, key: string) =>
    stableId(`jin:proposal:${versionId}:${key}`),
};
