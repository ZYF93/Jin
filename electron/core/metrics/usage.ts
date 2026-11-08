import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageMetrics } from "../../../shared/ipc";
import { ulid } from "../ids/ulid";
import { cachePath } from "../project/config";

export type UsageSource = "plan" | "semantic" | "implement" | "eko";

export interface ProviderTokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface UsageEntry extends ProviderTokenUsage {
  id: string;
  at: string;
  source: UsageSource;
  model: string;
  costUsd: number;
  priced: boolean;
}

export interface PriceRates {
  inputPerMillion: number;
  outputPerMillion: number;
}

const FILE = "usage.json";
const MAX_ENTRIES = 4000;

function counter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function rate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function costOf(usage: ProviderTokenUsage, rates: PriceRates): number {
  const input = counter(usage.promptTokens);
  const output = counter(usage.completionTokens);
  const cost =
    (input / 1_000_000) * rate(rates.inputPerMillion) +
    (output / 1_000_000) * rate(rates.outputPerMillion);
  return Math.round(cost * 1e8) / 1e8;
}

function isEntry(value: unknown): value is UsageEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.at === "string" &&
    (entry.source === "plan" ||
      entry.source === "semantic" ||
      entry.source === "implement" ||
      entry.source === "eko") &&
    typeof entry.model === "string" &&
    typeof entry.promptTokens === "number" &&
    typeof entry.completionTokens === "number" &&
    typeof entry.costUsd === "number" &&
    typeof entry.priced === "boolean"
  );
}

/**
 * Local provider usage ledger. It is deliberately a disposable cache: tokens
 * and costs are operational telemetry, not part of the architecture ledger, so
 * deleting `.jin/cache/usage.json` only resets the dashboard.
 */
export class UsageLedger {
  private entries: UsageEntry[] = [];
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    this.load();
  }

  private filePath(): string {
    return join(cachePath(this.root), FILE);
  }

  private load(): void {
    const path = this.filePath();
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) return;
      const entries = (parsed as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) return;
      this.entries = entries.filter(isEntry).slice(-MAX_ENTRIES);
    } catch {
      // A corrupt telemetry cache must never prevent a project from opening.
      this.entries = [];
    }
  }

  private persist(): void {
    try {
      const dir = cachePath(this.root);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        this.filePath(),
        JSON.stringify({ version: 1, entries: this.entries }),
        "utf8",
      );
    } catch {
      // Usage is best-effort; the WAL and implementation work continue.
    }
  }

  record(source: UsageSource, model: string, usage: ProviderTokenUsage, rates: PriceRates): void {
    const promptTokens = counter(usage.promptTokens);
    const completionTokens = counter(usage.completionTokens);
    if (promptTokens === 0 && completionTokens === 0) return;
    const priced =
      (promptTokens > 0 && rate(rates.inputPerMillion) > 0) ||
      (completionTokens > 0 && rate(rates.outputPerMillion) > 0);
    this.entries.push({
      id: ulid(),
      at: new Date().toISOString(),
      source,
      model,
      promptTokens,
      completionTokens,
      costUsd: costOf({ promptTokens, completionTokens }, rates),
      priced,
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    this.persist();
  }

  totals(): UsageMetrics {
    const totals: UsageMetrics = {
      calls: this.entries.length,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      pricedCalls: 0,
    };
    for (const entry of this.entries) {
      totals.promptTokens += entry.promptTokens;
      totals.completionTokens += entry.completionTokens;
      totals.costUsd += entry.costUsd;
      if (entry.priced) totals.pricedCalls += 1;
    }
    totals.totalTokens = totals.promptTokens + totals.completionTokens;
    totals.costUsd = Math.round(totals.costUsd * 1e8) / 1e8;
    return totals;
  }

  /** Test/debug helper: the raw, bounded ledger. */
  list(): UsageEntry[] {
    return [...this.entries];
  }
}
