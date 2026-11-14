import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { globFiles, globToRegExp, grepFiles } from "./code-search";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("globToRegExp", () => {
  it("matches exact, wildcard and recursive globs", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false); // [^/]* has no slash
    expect(globToRegExp("*.ts").test("src/deep/a.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("a{b,c}.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a{b,c}.ts").test("ac.ts")).toBe(true);
    expect(globToRegExp("a?c.ts").test("axc.ts")).toBe(true);
  });
});

describe("grepFiles / globFiles", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jin-cs-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(): void {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const count = 1;\n");
    writeFileSync(join(root, "src", "b.tsx"), "import { count } from './a';\n");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "x.js"), "count = 999;\n");
  }

  it("finds text matches and skips ignored directories", () => {
    fixture();
    const result = grepFiles(root, "count");
    const paths = result.hits.map((hit) => hit.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.tsx");
    expect(paths).not.toContain("node_modules/pkg/x.js");
  });

  it("filters files with the glob option", () => {
    fixture();
    const result = grepFiles(root, "count", { glob: "**/*.tsx" });
    expect(result.hits.map((hit) => hit.path)).toEqual(["src/b.tsx"]);
  });

  it("reports no matches honestly", () => {
    fixture();
    expect(grepFiles(root, "zzz-not-here").hits).toEqual([]);
  });

  it("lists files matching a glob", () => {
    fixture();
    const result = globFiles(root, "src/*.ts");
    expect(result.paths).toEqual(["src/a.ts"]);
  });
});
