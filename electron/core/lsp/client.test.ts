import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { openSqlite } from "../db/schema";
import { flattenDocumentSymbols, symbolKind, type LspFacts } from "./client";
import { LspStore } from "./store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LSP facts", () => {
  it("flattens hierarchical DocumentSymbols into 1-based scan members", () => {
    const symbols = flattenDocumentSymbols("src/counter.tsx", [
      {
        name: "Counter",
        kind: 5,
        range: { start: { line: 4, character: 0 } },
        selectionRange: { start: { line: 4, character: 16 } },
        children: [
          {
            name: "increment",
            kind: 6,
            range: { start: { line: 8, character: 2 } },
            selectionRange: { start: { line: 8, character: 8 } },
          },
          {
            name: "count",
            kind: 7,
            range: { start: { line: 6, character: 2 } },
            selectionRange: { start: { line: 6, character: 8 } },
          },
        ],
      },
      { name: "file.tsx", kind: 1, range: { start: { line: 0, character: 0 } } },
    ]);

    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual([
      "field:Counter",
      "method:increment",
      "property:count",
    ]);
    expect(symbols[0]?.line).toBe(5);
    expect(symbols[0]?.character).toBe(17);
    expect(symbols[1]?.detail).toBe("method");
  });

  it("reads SymbolInformation locations and skips module-level noise", () => {
    const symbols = flattenDocumentSymbols("src/math.ts", [
      {
        name: "sumAll",
        kind: 12,
        location: { range: { start: { line: 2, character: 4 } } },
      },
      { name: "src", kind: 2, location: { range: { start: { line: 0, character: 0 } } } },
    ]);
    expect(symbols).toEqual([
      expect.objectContaining({ name: "sumAll", kind: "method", line: 3, character: 5 }),
    ]);
    expect(symbolKind(5)).toBe("class");
    expect(symbolKind(999)).toBe("symbol");
  });

  it("does not invent a source position when the server omits its range", () => {
    const symbols = flattenDocumentSymbols("src/math.ts", [{ name: "sumAll", kind: 12 }]);
    expect(symbols).toEqual([expect.objectContaining({ name: "sumAll", kind: "method" })]);
    expect(symbols[0]?.line).toBeUndefined();
  });

  it("persists observations separately from the WAL index", () => {
    const root = mkdtempSync(join(tmpdir(), "jin-lsp-"));
    roots.push(root);
    const db = openSqlite(join(root, "index.db"));
    try {
      const store = new LspStore(db);
      const facts: LspFacts = {
        symbols: [
          {
            path: "src/counter.tsx",
            name: "Counter",
            kind: "field",
            line: 5,
            character: 17,
            detail: "class",
          },
        ],
        diagnostics: [
          {
            path: "src/counter.tsx",
            line: 9,
            character: 3,
            severity: "error",
            message: "Type mismatch",
            source: "ts",
          },
        ],
        servers: [
          { id: "typescript", server: "typescript-language-server", symbols: 1, diagnostics: 1 },
        ],
        collectedAt: new Date().toISOString(),
      };
      store.replaceAll(facts);
      expect(store.counts()).toEqual({ symbols: 1, diagnostics: 1, errors: 1 });
      store.replaceAll({ ...facts, symbols: [], diagnostics: [] });
      expect(store.counts()).toEqual({ symbols: 0, diagnostics: 0, errors: 0 });
    } finally {
      db.close();
    }
  });
});
