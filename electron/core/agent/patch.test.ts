import { describe, expect, it } from "vite-plus/test";
import { applyUnifiedPatchFile, applyUnifiedPatchText, parseUnifiedPatch } from "./patch";

const modifyPatch = `--- a/src/counter.ts
+++ b/src/counter.ts
@@ -1,2 +1,2 @@
 export const count = 0;
-export const label = "old";
+export const label = "new";
`;

describe("parseUnifiedPatch", () => {
  it("parses a multi-file patch with normalized project paths", () => {
    const files = parseUnifiedPatch(`${modifyPatch}
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`);
    expect(files.map((file) => file.path)).toEqual(["src/counter.ts", "src/new.ts"]);
    expect(files[0]?.isNew).toBe(false);
    expect(files[1]?.isNew).toBe(true);
    expect(files[1]?.isDelete).toBe(false);
  });

  it("accepts a hunk-only patch when a fallback path is supplied", () => {
    const files = parseUnifiedPatch(
      `@@ -1,2 +1,2 @@
 export const count = 0;
-export const label = "old";
+export const label = "new";
`,
      "src/counter.ts",
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/counter.ts");
    expect(files[0]?.isNew).toBe(false);
  });

  it("repairs incorrect hunk line counts while retaining source validation", () => {
    const files = parseUnifiedPatch(
      `--- a/shared/agents.ts
+++ b/shared/agents.ts
@@ -0,0 +1,0 @@
+export interface AgentConfig {
+  name: string;
+  enabled: boolean;
+}
`,
    );
    expect(files).toHaveLength(1);
    expect(applyUnifiedPatchFile("", files[0]!)).toBe(
      "export interface AgentConfig {\n  name: string;\n  enabled: boolean;\n}\n",
    );
  });

  it("rejects renames, absolute paths and Jin/Git internals", () => {
    expect(() =>
      parseUnifiedPatch(`--- a/src/a.ts
+++ b/src/b.ts
@@ -1 +1 @@
-a
+b
`),
    ).toThrow(/Renames are not supported/);

    expect(() =>
      parseUnifiedPatch(`--- a/../outside.ts
+++ b/../outside.ts
@@ -1 +1 @@
-a
+b
`),
    ).toThrow(/Unsafe file path|Refusing to write/);

    expect(() =>
      parseUnifiedPatch(`--- a/.git/config
+++ b/.git/config
@@ -1 +1 @@
-a
+b
`),
    ).toThrow(/Refusing to write/);
  });

  it("rejects empty and hunk-less patches", () => {
    expect(() => parseUnifiedPatch("   ")).toThrow(/empty/i);
    expect(() => parseUnifiedPatch("--- a/src/a.ts\n+++ b/src/a.ts\n")).toThrow(/no file hunks/i);
  });
});

describe("applyUnifiedPatchFile", () => {
  it("applies a modification to the in-memory source", () => {
    const [file] = parseUnifiedPatch(modifyPatch);
    expect(file).toBeDefined();
    expect(
      applyUnifiedPatchFile('export const count = 0;\nexport const label = "old";\n', file!),
    ).toBe('export const count = 0;\nexport const label = "new";\n');
  });

  it("creates a new file from /dev/null and deletes to null", () => {
    const [created] = parseUnifiedPatch(`--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`);
    expect(applyUnifiedPatchFile("", created!)).toBe("export const x = 1;\nexport const y = 2;\n");

    const [deleted] = parseUnifiedPatch(`--- a/src/new.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const x = 1;
-export const y = 2;
`);
    expect(deleted?.isDelete).toBe(true);
    expect(
      applyUnifiedPatchFile("export const x = 1;\nexport const y = 2;\n", deleted!),
    ).toBeNull();
  });

  it("explains a stale patch instead of silently writing", () => {
    const [file] = parseUnifiedPatch(
      `@@ -1,2 +1,2 @@
 completely unrelated context
-export const label = "old";
+export const label = "new";
`,
      "src/counter.ts",
    );
    expect(() =>
      applyUnifiedPatchFile('export const count = 0;\nexport const label = "old";\n', file!),
    ).toThrow(/does not apply.*Re-read/);
  });

  it("applies a single-file patch by text and path", () => {
    expect(
      applyUnifiedPatchText(
        'export const count = 0;\nexport const label = "old";\n',
        modifyPatch,
        "src/counter.ts",
      ),
    ).toBe('export const count = 0;\nexport const label = "new";\n');
  });
});
