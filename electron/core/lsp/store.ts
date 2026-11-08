import type { DatabaseSync } from "node:sqlite";
import type { LspFacts } from "./client";

/**
 * LSP facts are disposable observations. They live beside the WAL-derived
 * index in `.jin/cache/index.db` and are rewritten after each scan.
 */
export class LspStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  replaceAll(facts: LspFacts): void {
    const insertSymbol = this.db.prepare(`
      INSERT OR REPLACE INTO lsp_symbols(path, name, kind, line, character, detail)
      VALUES(?, ?, ?, ?, ?, ?)
    `);
    const insertDiagnostic = this.db.prepare(`
      INSERT INTO lsp_diagnostics(path, line, character, severity, message, source)
      VALUES(?, ?, ?, ?, ?, ?)
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM lsp_symbols");
      this.db.exec("DELETE FROM lsp_diagnostics");
      for (const symbol of facts.symbols) {
        insertSymbol.run(
          symbol.path,
          symbol.name,
          symbol.kind,
          symbol.line ?? 1,
          symbol.character ?? 1,
          symbol.detail,
        );
      }
      for (const diagnostic of facts.diagnostics) {
        insertDiagnostic.run(
          diagnostic.path,
          diagnostic.line,
          diagnostic.character,
          diagnostic.severity,
          diagnostic.message,
          diagnostic.source,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  counts(): { symbols: number; diagnostics: number; errors: number } {
    const symbols = this.db.prepare("SELECT COUNT(*) AS count FROM lsp_symbols").get() as
      | { count: number }
      | undefined;
    const diagnostics = this.db.prepare("SELECT COUNT(*) AS count FROM lsp_diagnostics").get() as
      | { count: number }
      | undefined;
    const errors = this.db
      .prepare("SELECT COUNT(*) AS count FROM lsp_diagnostics WHERE severity = 'error'")
      .get() as { count: number } | undefined;
    return {
      symbols: Number(symbols?.count ?? 0),
      diagnostics: Number(diagnostics?.count ?? 0),
      errors: Number(errors?.count ?? 0),
    };
  }
}
