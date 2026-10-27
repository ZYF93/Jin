import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchSnapshot } from "../../../shared/arch/types";
import type { ReuseCandidate, ReusePlan } from "../../../shared/ipc";
import type { ScanResult, ScannedFile } from "../scan/scanner";

interface RagDoc {
  path: string;
  title: string;
  symbols: string;
  responsibility: string;
  text: string;
  tokens: Map<string, number>;
  architectureText: string;
}

const MAX_DOC_CHARS = 160_000;

function tokenize(value: string): string[] {
  const lower = value.toLowerCase();
  const latin = lower.match(/[a-z_$][a-z0-9_$.-]*/g) ?? [];
  const cjk = lower.match(/[\u3400-\u9fff]/g) ?? [];
  const cjkBigrams: string[] = [];
  for (let index = 0; index < cjk.length - 1; index += 1) {
    cjkBigrams.push(`${cjk[index]}${cjk[index + 1]}`);
  }
  return [...latin, ...cjk, ...cjkBigrams].filter((term) => term.length > 1);
}

function tokenMap(value: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokenize(value)) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snippetFor(text: string, query: string): string {
  const terms = [...new Set(tokenize(query))].filter((term) => term.length > 1);
  const lower = text.toLowerCase();
  let position = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (position < 0 || found < position)) position = found;
  }
  if (position < 0) {
    return text.split("\n").slice(0, 8).join("\n").slice(0, 500);
  }
  const start = Math.max(0, text.lastIndexOf("\n", Math.max(0, position - 300)) + 1);
  const end = text.indexOf("\n", Math.min(text.length, position + 700));
  return text.slice(start, end < 0 ? Math.min(text.length, start + 1000) : end).trim().slice(0, 800);
}

/**
 * Lightweight code reuse retrieval.
 *
 * It uses an in-memory BM25-like keyword score over the scanned source and the
 * approved architecture's responsibility text. The project index already owns
 * the authoritative FTS table for nodes; this service is intentionally a pure,
 * rebuildable cache for the agent's ReusePlan and costs no extra IPC.
 */
export class RagService {
  private docs: RagDoc[] = [];
  private updatedAt: string | null = null;

  update(root: string, scan: ScanResult, snapshot: ArchSnapshot | null): void {
    this.docs = scan.files.map((file) => {
      const node = snapshot
        ? Object.values(snapshot.nodes).find((candidate) => candidate.file === file.path)
        : null;
      let text = "";
      try {
        text = readFileSync(join(root, file.path), "utf8").slice(0, MAX_DOC_CHARS);
      } catch {
        text = "";
      }
      const architectureText = node
        ? `${node.name}\n${node.responsibility}\n${JSON.stringify(node.metadata)}`
        : "";
      return {
        path: file.path,
        title: file.title,
        symbols: file.exports.join(", "),
        responsibility: file.responsibility,
        text,
        tokens: tokenMap(`${file.path}\n${file.title}\n${file.exports.join(" ")}\n${file.responsibility}\n${text}`),
        architectureText,
      };
    });
    this.updatedAt = new Date().toISOString();
  }

  get size(): number {
    return this.docs.length;
  }

  search(query: string, limit = 8): ReuseCandidate[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const documentCount = Math.max(1, this.docs.length);
    const averageLength =
      this.docs.reduce((sum, doc) => sum + doc.tokens.size, 0) / documentCount || 1;
    const documentFrequency = new Map<string, number>();
    for (const term of terms) {
      let count = 0;
      for (const doc of this.docs) if (doc.tokens.has(term)) count += 1;
      documentFrequency.set(term, count);
    }

    const scored = this.docs.map((doc) => {
      let score = 0;
      for (const term of terms) {
        const frequency = doc.tokens.get(term) ?? 0;
        if (frequency === 0) continue;
        const idf = Math.log(
          1 + (documentCount - (documentFrequency.get(term) ?? 0) + 0.5) /
            ((documentFrequency.get(term) ?? 0) + 0.5),
        );
        const lengthNorm = 1.2 * (0.25 + (0.75 * doc.tokens.size) / averageLength);
        score += idf * ((frequency * 2.2) / (frequency + lengthNorm));
        if (doc.path.toLowerCase().includes(term)) score += 1.4;
        if (doc.title.toLowerCase().includes(term)) score += 1.1;
        if (doc.symbols.toLowerCase().includes(term)) score += 0.9;
        if (doc.architectureText.toLowerCase().includes(term)) score += 0.5;
      }
      return { doc, score };
    });

    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(30, limit)))
      .map(({ doc, score }) => ({
        path: doc.path,
        symbol: doc.symbols.slice(0, 180),
        score: Math.round(score * 100) / 100,
        reason:
          doc.responsibility ||
          `Matches ${terms.slice(0, 5).join(", ")} in the scanned source.`,
        snippet: snippetFor(doc.text, query),
      }));
  }

  plan(query: string): ReusePlan {
    const candidates = this.search(query, 8);
    return {
      query,
      summary:
        candidates.length > 0
          ? `Found ${candidates.length} existing unit${candidates.length === 1 ? "" : "s"} worth reusing before writing new code.`
          : "No close existing implementation found; new code may be justified, but explain why reuse is not possible.",
      candidates,
      createdAt: new Date().toISOString(),
    };
  }

  filesForPaths(paths: readonly string[]): ScannedFile[] {
    const wanted = new Set(paths);
    return this.docs
      .filter((doc) => wanted.has(doc.path))
      .map((doc) => ({
        path: doc.path,
        absolute: "",
        language: "",
        lines: doc.text.split("\n").length,
        bytes: doc.text.length,
        imports: [],
        exports: doc.symbols ? doc.symbols.split(", ").filter(Boolean) : [],
        members: [],
        kind: "function" as const,
        title: doc.title,
        responsibility: doc.responsibility,
      }));
  }

  textForPath(path: string): string | null {
    return this.docs.find((doc) => doc.path === path)?.text ?? null;
  }

  lastUpdated(): string | null {
    return this.updatedAt;
  }

  static scoreFloor(score: number): number {
    return clamp(Math.round(score * 100) / 100, 0, 999);
  }
}
