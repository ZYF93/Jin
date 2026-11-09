import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArchSnapshot } from "../../../shared/ledger/types";
import type { ReuseCandidate, ReusePlan } from "../../../shared/ipc";
import type { ScanResult, ScannedFile } from "../scan/scanner";
import { RagStore, type PersistedRagDoc } from "./rag-store";
import { cosine, tokenMap, tokenize, vectorize } from "./tokens";

interface RagDoc {
  path: string;
  title: string;
  symbols: string;
  responsibility: string;
  text: string;
  nodeId: string | null;
  tokens: Map<string, number>;
  vector: Float32Array;
  architectureText: string;
  sourceMtimeMs: number;
  sourceSize: number;
}

const MAX_DOC_CHARS = 160_000;

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
  return text
    .slice(start, end < 0 ? Math.min(text.length, start + 1000) : end)
    .trim()
    .slice(0, 800);
}

/**
 * Lightweight code reuse retrieval.
 *
 * It combines a BM25-like keyword score, a deterministic feature-hashed dense
 * vector, an FTS5 candidate prefilter and one-hop architecture graph expansion.
 * The in-memory view is a cache; `RagStore` mirrors it into `.jin/cache` so a
 * restart can answer before the next scan completes.
 */
export class RagService {
  private docs: RagDoc[] = [];
  private updatedAt: string | null = null;
  private readonly store: RagStore | null;
  private hydrated = false;
  private pathToNodeId = new Map<string, string>();
  private neighbors = new Map<string, Set<string>>();

  constructor(store: RagStore | null = null) {
    this.store = store;
  }

  hydrate(): void {
    if (this.hydrated || this.docs.length > 0 || !this.store) {
      this.hydrated = true;
      return;
    }
    try {
      const persisted = this.store.loadAll();
      this.docs = persisted.map((doc) => ({
        path: doc.path,
        title: doc.title,
        symbols: doc.symbols,
        responsibility: doc.responsibility,
        text: doc.text,
        nodeId: doc.nodeId,
        tokens: tokenMap(
          `${doc.path}\n${doc.title}\n${doc.symbols}\n${doc.responsibility}\n${doc.text}`,
        ),
        vector: doc.vector,
        architectureText: doc.architectureText,
        sourceMtimeMs: doc.sourceMtimeMs,
        sourceSize: doc.sourceSize,
      }));
      this.pathToNodeId = new Map(
        persisted
          .filter((doc): doc is PersistedRagDoc & { nodeId: string } => Boolean(doc.nodeId))
          .map((doc) => [doc.path, doc.nodeId]),
      );
      this.updatedAt = new Date().toISOString();
    } catch {
      this.docs = [];
    }
    this.hydrated = true;
  }

  update(root: string, scan: ScanResult, snapshot: ArchSnapshot | null): void {
    this.hydrate();
    const previous = new Map(this.docs.map((doc) => [doc.path, doc]));
    const fileToNode = new Map<string, ArchSnapshot["nodes"][string]>();
    if (snapshot) {
      for (const node of Object.values(snapshot.nodes)) {
        if (node.file && !fileToNode.has(node.file)) fileToNode.set(node.file, node);
      }
    }

    this.pathToNodeId = new Map();
    this.neighbors = new Map();
    if (snapshot) {
      const link = (left: string, right: string): void => {
        const leftSet = this.neighbors.get(left) ?? new Set<string>();
        leftSet.add(right);
        this.neighbors.set(left, leftSet);
        const rightSet = this.neighbors.get(right) ?? new Set<string>();
        rightSet.add(left);
        this.neighbors.set(right, rightSet);
      };
      for (const edge of Object.values(snapshot.edges)) link(edge.from, edge.to);
      for (const node of Object.values(snapshot.nodes)) {
        if (node.parentId) link(node.id, node.parentId);
      }
      for (const [file, node] of fileToNode) this.pathToNodeId.set(file, node.id);
    }

    const now = new Date().toISOString();
    const changed: RagDoc[] = [];
    this.docs = scan.files.map((file) => {
      const node = fileToNode.get(file.path) ?? null;
      const cached = previous.get(file.path);
      let sourceMtimeMs = 0;
      let sourceSize = file.bytes;
      try {
        const stat = statSync(join(root, file.path));
        sourceMtimeMs = stat.mtimeMs;
        sourceSize = stat.size;
      } catch {
        // Keep the scanned size and force the file to be read below.
      }
      const symbols = file.exports.join(", ");
      const sourceUnchanged = Boolean(
        cached &&
        cached.sourceMtimeMs > 0 &&
        cached.sourceMtimeMs === sourceMtimeMs &&
        cached.sourceSize === sourceSize &&
        cached.title === file.title &&
        cached.symbols === symbols &&
        cached.responsibility === file.responsibility,
      );
      let text = cached?.text ?? "";
      if (!sourceUnchanged) {
        try {
          text = readFileSync(join(root, file.path), "utf8").slice(0, MAX_DOC_CHARS);
        } catch {
          text = "";
        }
      }
      const architectureParts: string[] = [];
      if (node) {
        architectureParts.push(node.name, node.responsibility);
        const metadata = JSON.stringify(node.metadata);
        if (metadata && metadata !== "{}") architectureParts.push(metadata);
        let parent = node.parentId && snapshot ? snapshot.nodes[node.parentId] : null;
        let depth = 0;
        while (parent && depth < 3) {
          architectureParts.push(parent.name, parent.responsibility);
          parent = parent.parentId && snapshot ? snapshot.nodes[parent.parentId] : null;
          depth += 1;
        }
      }
      const nodeId = node?.id ?? null;
      const architectureText = architectureParts.join("\n");
      const doc: RagDoc = cached && sourceUnchanged
        ? {
            ...cached,
            nodeId,
            architectureText,
            sourceMtimeMs,
            sourceSize,
          }
        : (() => {
            const tokens = tokenMap(
              `${file.path}\n${file.title}\n${file.exports.join(" ")}\n${file.responsibility}\n${text}`,
            );
            return {
              path: file.path,
              title: file.title,
              symbols,
              responsibility: file.responsibility,
              text,
              nodeId,
              tokens,
              vector: vectorize(tokens),
              architectureText,
              sourceMtimeMs,
              sourceSize,
            };
          })();
      if (
        !sourceUnchanged ||
        cached?.nodeId !== doc.nodeId ||
        cached?.architectureText !== doc.architectureText ||
        cached?.title !== doc.title ||
        cached?.symbols !== doc.symbols ||
        cached?.responsibility !== doc.responsibility
      ) {
        changed.push(doc);
      }
      return doc;
    });
    this.updatedAt = now;
    this.hydrated = true;
    if (this.store) {
      try {
        const currentPaths = new Set(this.docs.map((doc) => doc.path));
        const deletedPaths = [...previous.keys()].filter((path) => !currentPaths.has(path));
        this.store.syncChanged(
          changed.map((doc) => ({
            path: doc.path,
            title: doc.title,
            symbols: doc.symbols,
            responsibility: doc.responsibility,
            text: doc.text,
            nodeId: doc.nodeId,
            vector: doc.vector,
            updatedAt: now,
            sourceMtimeMs: doc.sourceMtimeMs,
            sourceSize: doc.sourceSize,
            architectureText: doc.architectureText,
          })),
          deletedPaths,
        );
      } catch {
        // The durable cache is disposable; scanning and retrieval still work.
      }
    }
  }

  get size(): number {
    this.hydrate();
    return this.docs.length;
  }

  search(query: string, limit = 8): ReuseCandidate[] {
    this.hydrate();
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const queryVector = vectorize(tokenMap(query));
    const documentCount = Math.max(1, this.docs.length);
    const averageLength =
      this.docs.reduce((sum, doc) => sum + doc.tokens.size, 0) / documentCount || 1;
    const documentFrequency = new Map<string, number>();
    for (const term of terms) {
      let count = 0;
      for (const doc of this.docs) if (doc.tokens.has(term)) count += 1;
      documentFrequency.set(term, count);
    }
    const ftsPaths = new Set(this.store?.searchPaths(query, 64) ?? []);

    const scored = this.docs.map((doc) => {
      let lexical = 0;
      for (const term of terms) {
        const frequency = doc.tokens.get(term) ?? 0;
        if (frequency === 0) continue;
        const idf = Math.log(
          1 +
            (documentCount - (documentFrequency.get(term) ?? 0) + 0.5) /
              ((documentFrequency.get(term) ?? 0) + 0.5),
        );
        const lengthNorm = 1.2 * (0.25 + (0.75 * doc.tokens.size) / averageLength);
        lexical += idf * ((frequency * 2.2) / (frequency + lengthNorm));
        if (doc.path.toLowerCase().includes(term)) lexical += 1.4;
        if (doc.title.toLowerCase().includes(term)) lexical += 1.1;
        if (doc.symbols.toLowerCase().includes(term)) lexical += 0.9;
        if (doc.architectureText.toLowerCase().includes(term)) lexical += 0.5;
      }
      if (ftsPaths.has(doc.path)) lexical += 0.35;
      const vectorScore = Math.max(0, cosine(queryVector, doc.vector));
      return { doc, score: lexical + vectorScore * 2.8 };
    });

    // One-hop graph expansion: the file that owns a matching concept is often
    // used by, or grouped under, the file the user actually wants to change.
    const preliminary = scored.sort((a, b) => b.score - a.score);
    const seeds = preliminary.filter((entry) => entry.doc.nodeId && entry.score > 0.01).slice(0, 6);
    const seedIds = new Set(seeds.map((entry) => entry.doc.nodeId).filter(Boolean));
    const related = new Set<string>();
    for (const seed of seeds) {
      if (!seed.doc.nodeId) continue;
      for (const neighbor of this.neighbors.get(seed.doc.nodeId) ?? []) {
        if (!seedIds.has(neighbor)) related.add(neighbor);
      }
    }
    const maxSeedScore = preliminary[0]?.score ?? 0;
    const graphBoost = Math.min(1.4, maxSeedScore * 0.14);
    const expanded = related.size
      ? preliminary.map((entry) =>
          entry.doc.nodeId && related.has(entry.doc.nodeId)
            ? { ...entry, score: entry.score + graphBoost }
            : entry,
        )
      : preliminary;

    return expanded
      .filter((entry) => entry.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(30, limit)))
      .map(({ doc, score }) => ({
        path: doc.path,
        symbol: doc.symbols.slice(0, 180),
        score: Math.round(score * 100) / 100,
        reason:
          doc.responsibility || `Matches ${terms.slice(0, 5).join(", ")} in the scanned source.`,
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
    this.hydrate();
    const wanted = new Set(paths);
    return this.docs
      .filter((doc) => wanted.has(doc.path))
      .map((doc) => ({
        path: doc.path,
        absolute: "",
        language: "",
        lines: doc.text.split("\n").length,
        symbolLocations: {},
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
    this.hydrate();
    return this.docs.find((doc) => doc.path === path)?.text ?? null;
  }

  lastUpdated(): string | null {
    return this.updatedAt;
  }

  static scoreFloor(score: number): number {
    return clamp(Math.round(score * 100) / 100, 0, 999);
  }
}

export { RagStore } from "./rag-store";
