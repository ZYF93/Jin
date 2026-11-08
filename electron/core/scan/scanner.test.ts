import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { JinConfig } from "../project/config";
import { scanProject } from "./scanner";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "jin-polyglot-"));
  roots.push(root);
  const files: Record<string, string> = {
    "src/App.tsx": [
      'import { Button } from "./components/Button";',
      'import { useCounter } from "./hooks/useCounter";',
      'import { sum } from "./lib/math";',
      'import React from "react";',
      'import { z } from "@scope/pkg";',
      "export function App() {",
      "  const count = useCounter();",
      "  return <Button label={String(sum(count, 1))} />;",
      "}",
    ].join("\n"),
    "src/components/Button.tsx": [
      "export interface ButtonProps { label: string; }",
      "export function Button({ label }: ButtonProps) {",
      "  return <button>{label}</button>;",
      "}",
    ].join("\n"),
    "src/hooks/useCounter.ts": ["export function useCounter() {", "  return 1;", "}"].join("\n"),
    "src/lib/math.ts": ["export function sum(a: number, b: number) {", "  return a + b;", "}"].join(
      "\n",
    ),
    "src/Widget.vue": [
      "<template><div>{{ label }}</div></template>",
      '<script setup lang="ts">',
      'import { computed } from "vue";',
      "const label = computed(() => 'widget');",
      "</script>",
    ].join("\n"),
    "src/py/service.py": ["class Service:", "    def run(self):", "        return 'ok'"].join("\n"),
    "src/java/Main.java": [
      "package demo;",
      "import java.util.List;",
      "public class Main {",
      "  public static void main(String[] args) {",
      '    System.out.println("hello");',
      "  }",
      "}",
    ].join("\n"),
    "src/kotlin/App.kt": ["package demo", "fun main() {", '  println("hello")', "}"].join("\n"),
    "src/go/main.go": [
      "package main",
      'import "fmt"',
      "type Server struct {}",
      "func main() {",
      '  fmt.Println("hello")',
      "}",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

function config(): JinConfig {
  return {
    version: 1,
    project: {
      name: "Polyglot",
      languages: ["typescript", "vue", "python", "java", "kotlin", "go"],
    },
    scan: { roots: ["src"], ignore: [] },
    approval: { mode: "single", required: 1 },
    ui: { theme: "dark", glass: "subtle" },
  };
}

describe("scanProject", () => {
  it("builds one architecture from TypeScript, Vue, Python, Java, Kotlin and Go", () => {
    const root = fixture();
    const scan = scanProject(root, config());

    expect(scan.stats.files).toBe(9);
    expect(scan.stats.languages).toEqual({
      typescript: 2,
      tsx: 2,
      vue: 1,
      python: 1,
      java: 1,
      kotlin: 1,
      go: 1,
    });

    const files = new Map(scan.files.map((file) => [file.path, file]));
    expect(files.get("src/components/Button.tsx")?.exports).toContain("Button");
    expect(files.get("src/hooks/useCounter.ts")?.kind).toBe("hook");
    expect(files.get("src/components/Button.tsx")?.kind).toBe("component");
    expect(files.get("src/Widget.vue")?.exports).toEqual(["Widget"]);
    expect(files.get("src/py/service.py")?.members.map((member) => member.name)).toContain("run");
    expect(files.get("src/java/Main.java")?.exports).toContain("Main");
    expect(files.get("src/kotlin/App.kt")?.members.map((member) => member.name)).toContain("main");
    expect(files.get("src/go/main.go")?.exports).toEqual(["Server", "main"]);

    const nodes = new Map(scan.nodes.map((node) => [node.id, node]));
    const button = scan.nodes.find((node) => node.file === "src/components/Button.tsx");
    expect(button?.level).toBe("L1");
    expect(button?.kind).toBe("component");
    expect(button?.metadata.symbolLocations).toEqual({});
    expect(nodes.get(button?.parentId ?? "")?.path).toBe("src/components");
    const app = scan.nodes.find((node) => node.file === "src/App.tsx");
    expect(app).toBeDefined();
    expect(nodes.get(app?.parentId ?? "")?.path).toBe("src");

    const external = scan.nodes
      .filter((node) => node.kind === "external")
      .map((node) => node.name)
      .sort();
    expect(external).toEqual(["@scope/pkg", "fmt", "java.util.List", "react", "vue"]);

    const edges = scan.edges.map((edge) => {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      return `${from?.file || from?.name}:${edge.kind}:${to?.file || to?.name}`;
    });
    expect(edges).toContain("src/App.tsx:depends_on:src/components/Button.tsx");
    expect(edges).toContain("src/App.tsx:depends_on:src/hooks/useCounter.ts");
    expect(edges).toContain("src/App.tsx:depends_on:react");
    expect(edges).toContain("src/App.tsx:depends_on:@scope/pkg");
  });

  it("merges LSP symbols into facets without duplicating structural members", () => {
    const root = fixture();
    const scan = scanProject(root, config(), {
      lspFacts: new Map([
        [
          "src/components/Button.tsx",
          [
            { name: "Button", kind: "method" as const },
            { name: "onClick", kind: "method" as const, line: 7 },
          ],
        ],
      ]),
    });

    const button = scan.nodes.find((node) => node.file === "src/components/Button.tsx");
    const facets = scan.nodes.filter(
      (node) => node.level === "facet" && node.parentId === button?.id,
    );
    expect(facets.filter((facet) => facet.name === "Button")).toHaveLength(1);
    expect(facets.find((facet) => facet.name === "onClick")?.metadata.line).toBe(7);
    expect(scan.nodes.some((node) => node.name === "ButtonProps")).toBe(false);
  });

  it("uses a neutral module kind and trusts only LSP source locations", () => {
    const root = fixture();
    const neutralPath = join(root, "src", "lib", "constants.ts");
    writeFileSync(neutralPath, "export const answer = 42;\n", "utf8");
    const factPath = join(root, "src", "lib", "ledger.ts");
    writeFileSync(factPath, "export class Ledger {\n  read() { return 1; }\n}\n", "utf8");

    const structuralScan = scanProject(root, config());
    const structuralRead = structuralScan.nodes.find(
      (node) => node.level === "facet" && node.name === "read",
    );
    const scan = scanProject(root, config(), {
      lspFacts: new Map([
        ["src/lib/ledger.ts", [{ name: "read", kind: "method" as const, line: 2, character: 3 }]],
      ]),
    });
    const constants = scan.nodes.find((node) => node.file === "src/lib/constants.ts");
    const ledger = scan.nodes.find((node) => node.file === "src/lib/ledger.ts");
    const readFact = scan.nodes.find((node) => node.level === "facet" && node.name === "read");

    expect(constants?.kind).toBe("module");
    expect(ledger?.kind).toBe("entity");
    expect(structuralRead?.metadata.line).toBeUndefined();
    expect(readFact?.metadata.line).toBe(2);
    expect(readFact?.metadata.character).toBe(3);
  });

  it("respects ignore rules and reports missing scan roots", () => {
    const root = fixture();
    writeFileSync(join(root, "src/ignored.ts"), "export const ignored = true;\n", "utf8");
    const custom = config();
    custom.scan = { roots: ["src", "missing"], ignore: ["src/ignored.ts"] };
    const scan = scanProject(root, custom);
    expect(scan.files.some((file) => file.path === "src/ignored.ts")).toBe(false);
    expect(scan.warnings.some((warning) => warning.includes("missing"))).toBe(true);
  });
});
