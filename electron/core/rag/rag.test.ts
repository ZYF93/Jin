import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ArchNode, ArchSnapshot } from "../../../shared/arch/types";
import { emptySnapshot } from "../arch/snapshot";
import { openSqlite } from "../db/schema";
import type { JinConfig } from "../project/config";
import { scanProject } from "../scan/scanner";
import { RagService, RagStore } from "./rag";

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jin-rag-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, "src", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return root;
}

const CONFIG: JinConfig = {
  version: 1,
  project: { name: "RAG fixture", languages: ["typescript"] },
  scan: { roots: ["src"], ignore: [] },
  approval: { mode: "single", required: 1 },
  ui: { theme: "dark", glass: "subtle" },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function archNode(id: string, name: string, path: string, responsibility: string): ArchNode {
  return {
    id,
    level: "L1",
    kind: "function",
    parentId: null,
    name,
    path,
    file: path,
    symbol: "",
    responsibility,
    intentId: null,
    status: "active",
    metadata: {},
    introducedIn: "v1",
    updatedIn: "v1",
    lastTouchedIn: null,
  };
}

describe("RagService", () => {
  it("ranks the unit that owns the requested concept first", () => {
    const root = fixture({
      "invoice.ts": [
        "/** Calculate invoice totals, tax, and line item amounts. */",
        "export function invoiceTotal(lines: readonly number[]): number {",
        "  return lines.reduce((sum, line) => sum + line, 0);",
        "}",
      ].join("\n"),
      "theme.ts": [
        "/** Resolve the active color theme. */",
        "export function resolveTheme(preference: string): string {",
        "  return preference;",
        "}",
      ].join("\n"),
    });
    const service = new RagService();
    service.update(root, scanProject(root, CONFIG), null);

    const results = service.search("calculate invoice tax totals", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toBe("src/invoice.ts");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it("supports Chinese bigram retrieval without a tokenizer service", () => {
    const root = fixture({
      "billing.ts": [
        "/** 发票税额计算，支持多行明细。 */",
        "export function invoiceTax(lines: readonly number[]): number {",
        "  return lines.reduce((sum, line) => sum + line, 0);",
        "}",
      ].join("\n"),
      "color.ts": "/** 主题颜色。 */\nexport const accent = \"cyan\";\n",
    });
    const service = new RagService();
    service.update(root, scanProject(root, CONFIG), null);

    const results = service.search("发票 税额", 3);
    expect(results[0]?.path).toBe("src/billing.ts");
  });

  it("expands one hop through architecture edges", () => {
    const root = fixture({
      "invoice.ts": "/** Invoice total helper. */\nexport function invoiceTotal() { return 0; }\n",
      "report.ts": "/** Exporter for downstream reporting. */\nexport function exportReport() { return 0; }\n",
    });
    const snapshot: ArchSnapshot = {
      ...emptySnapshot(),
      nodes: {
        invoice: archNode("invoice", "Invoice", "src/invoice.ts", "Invoice total helper."),
        report: archNode("report", "Report", "src/report.ts", "Exporter for downstream reporting."),
      },
      edges: {
        "edge-report-invoice": {
          id: "edge-report-invoice",
          from: "report",
          to: "invoice",
          kind: "depends_on",
          metadata: {},
          introducedIn: "v1",
        },
      },
    };
    const service = new RagService();
    service.update(root, scanProject(root, CONFIG), snapshot);

    const results = service.search("invoice total", 4);
    expect(results[0]?.path).toBe("src/invoice.ts");
    expect(results.some((candidate) => candidate.path === "src/report.ts")).toBe(true);
  });

  it("persists text, vectors, and Chinese FTS tokens across service restarts", () => {
    const root = fixture({
      "billing.ts": [
        "/** 发票税额计算，支持多行明细。 */",
        "export function invoiceTax(lines: readonly number[]): number {",
        "  return lines.reduce((sum, line) => sum + line, 0);",
        "}",
      ].join("\n"),
      "theme.ts": "/** Resolve the active color theme. */\nexport const accent = \"cyan\";\n",
    });
    const db = openSqlite(join(root, "index.db"));
    try {
      const store = new RagStore(db);
      const service = new RagService(store);
      service.update(root, scanProject(root, CONFIG), null);
      expect(store.count()).toBe(2);
      expect(store.searchPaths("发票 税额")[0]).toBe("src/billing.ts");

      const restored = new RagService(store);
      restored.hydrate();
      expect(restored.size).toBe(2);
      expect(restored.search("发票税额", 3)[0]?.path).toBe("src/billing.ts");
    } finally {
      db.close();
    }
  });
});
