/**
 * Public type boundary for the architecture ledger.
 *
 * WAL records are the durable source of truth; architecture snapshots are the
 * read model folded from approved WAL records. Consumers use this module for
 * both sides of that contract instead of depending on either internal type
 * file directly.
 */
export * from "../arch/types";
export * from "../wal/types";
