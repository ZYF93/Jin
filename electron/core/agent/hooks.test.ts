import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { expandArguments, loadCustomCommands, parseHooksConfig, runHooks } from "./hooks";

describe("parseHooksConfig", () => {
  it("keeps only well-formed rules", () => {
    const config = parseHooksConfig(
      JSON.stringify({
        hooks: [
          { event: "preToolUse", matcher: "^run_", command: "echo ok" },
          { event: "nope", command: "x" },
          { event: "postToolUse" },
          { event: "beforeImplement", command: "true" },
        ],
      }),
    );
    expect(config.hooks).toHaveLength(2);
    expect(config.hooks[0]?.event).toBe("preToolUse");
  });

  it("returns an empty config for malformed input", () => {
    expect(parseHooksConfig("not json").hooks).toEqual([]);
  });
});

describe("loadCustomCommands", () => {
  it("loads .md commands with a frontmatter description", () => {
    const root = mkdtempSync(join(tmpdir(), "jin-hooks-"));
    try {
      mkdirSync(join(root, ".jin", "commands"), { recursive: true });
      writeFileSync(
        join(root, ".jin", "commands", "explain.md"),
        "---\ndescription: Explain a file\n---\nExplain $1\n",
        "utf8",
      );
      const commands = loadCustomCommands(root);
      expect(commands).toHaveLength(1);
      expect(commands[0]?.name).toBe("explain");
      expect(commands[0]?.description).toBe("Explain a file");
      expect(expandArguments(commands[0]?.body ?? "", "src/app.ts")).toBe("Explain src/app.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nothing without a commands directory", () => {
    const root = mkdtempSync(join(tmpdir(), "jin-hooks-empty-"));
    try {
      expect(loadCustomCommands(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runHooks", () => {
  it("runs matching pre-tool hooks and can block a veto", async () => {
    const root = mkdtempSync(join(tmpdir(), "jin-hooks-run-"));
    try {
      mkdirSync(join(root, ".jin"), { recursive: true });
      const shell = process.platform === "win32" ? "powershell -Command " : "sh -c ";
      writeFileSync(
        join(root, ".jin", "hooks.json"),
        JSON.stringify({
          hooks: [
            { event: "preToolUse", matcher: "^run_shell$", command: "exit 1", blockOnError: true },
          ],
        }),
        "utf8",
      );
      const vetoed = await runHooks({ root, event: "preToolUse", tool: "run_shell", args: {} });
      expect(vetoed.blocked).toBe(true);
      const passed = await runHooks({ root, event: "preToolUse", tool: "read_file", args: {} });
      expect(passed.blocked).toBe(false);
      void shell;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
