import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  combinedAgentRules,
  globalAgentsMdPath,
  projectAgentsMdPath,
  readGlobalAgentsMd,
  readProjectAgentsMd,
  writeGlobalAgentsMd,
} from "./agents-md";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jin-agents-md-"));
  dirs.push(dir);
  return dir;
}

describe("agents-md", () => {
  it("reads and writes the global file in userData", () => {
    const dir = tempDir();
    expect(readGlobalAgentsMd(dir)).toBe("");
    const path = writeGlobalAgentsMd(dir, "# Rules\n\nBe concise.");
    expect(path).toBe(globalAgentsMdPath(dir));
    expect(readGlobalAgentsMd(dir)).toBe("# Rules\n\nBe concise.\n");
    expect(existsSync(path)).toBe(true);
  });

  it("reads the project file only from the project root", () => {
    const root = tempDir();
    expect(readProjectAgentsMd(root)).toBe("");
    writeFileSync(projectAgentsMdPath(root), "Project rules here.", "utf8");
    expect(readProjectAgentsMd(root)).toBe("Project rules here.");
  });

  it("combines both layers with clear section headers", () => {
    const userData = tempDir();
    const root = tempDir();
    writeGlobalAgentsMd(userData, "Global rule A.");
    writeFileSync(projectAgentsMdPath(root), "Project rule B.", "utf8");
    const { combined } = combinedAgentRules(userData, root);
    expect(combined).toContain("PROJECT RULES (AGENTS.md in the project root):");
    expect(combined).toContain("Project rule B.");
    expect(combined).toContain("GLOBAL RULES (user-level AGENTS.md):");
    expect(combined).toContain("Global rule A.");
  });

  it("returns an empty combined string when neither file exists", () => {
    const { combined } = combinedAgentRules(tempDir(), tempDir());
    expect(combined).toBe("");
  });

  it("truncates oversized rule files for prompts but keeps the file intact", () => {
    const userData = tempDir();
    const root = tempDir();
    const big = `${"x".repeat(20_000)} END-MARKER`;
    writeGlobalAgentsMd(userData, big);
    writeFileSync(projectAgentsMdPath(root), big, "utf8");
    // The stored file keeps the full content.
    expect(readFileSync(globalAgentsMdPath(userData), "utf8")).toContain("END-MARKER");
    // Prompt injection is clipped.
    const { combined } = combinedAgentRules(userData, root);
    expect(combined).toContain("truncated after 16000 characters");
    expect(combined.length).toBeLessThan(40_000);
  });

  it("creates missing userData directories on write", () => {
    const parent = tempDir();
    const nested = join(parent, "a", "b");
    const path = writeGlobalAgentsMd(nested, "hi");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("hi\n");
    mkdirSync(nested, { recursive: true });
  });
});
