import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { locateProject, readConfig, walPath } from "./config";
import { initProject } from "./init";

describe("project init", () => {
  it("creates the committed scaffold and ignored cache", () => {
    const root = mkdtempSync(join(tmpdir(), "jin-project-"));
    try {
      const result = initProject(root, {
        name: "Jin Test",
        languages: ["typescript", "react"],
      });

      expect(result.created).toBe(true);
      expect(existsSync(join(root, ".jin", "config.yaml"))).toBe(true);
      expect(existsSync(join(root, ".jin", "wal.jsonl"))).toBe(true);
      expect(existsSync(join(root, ".jin", "cache"))).toBe(true);
      expect(readFileSync(join(root, ".jin", ".gitignore"), "utf8")).toContain(
        "cache/",
      );

      const config = readConfig(root);
      expect(config.project.name).toBe("Jin Test");
      expect(config.project.languages).toEqual(["typescript", "react"]);
      expect(config.approval.mode).toBe("single");
      expect(locateProject(join(root, "src"))).toEqual({
        root,
        initialized: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent and force-init never truncates the WAL", () => {
    const root = mkdtempSync(join(tmpdir(), "jin-project-"));
    try {
      initProject(root, { name: "First" });
      const second = initProject(root);
      expect(second.created).toBe(false);
      expect(readConfig(root).project.name).toBe("First");

      writeFileSync(walPath(root), "sentinel\n", "utf8");
      initProject(root, { name: "Forced", force: true });
      expect(readFileSync(walPath(root), "utf8")).toBe("sentinel\n");
      expect(readConfig(root).project.name).toBe("Forced");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
