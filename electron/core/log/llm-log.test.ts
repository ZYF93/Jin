import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  clipPreview,
  currentLlmLogPath,
  initLlmLog,
  llmLogFile,
  logLlm,
  sanitizeUrl,
} from "./llm-log";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jin-llm-log-"));
  dirs.push(dir);
  return dir;
}

describe("llm log", () => {
  it("appends one JSONL entry per call", () => {
    const dir = tempLogDir();
    initLlmLog(dir);
    logLlm({ event: "request", phase: "plan", model: "m1", requestChars: 120 });
    logLlm({ event: "response", phase: "plan", model: "m1", responseChars: 30 });
    const file = currentLlmLogPath();
    expect(file).toContain(dir);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as { event: string; phase: string; ts: string };
    expect(first.event).toBe("request");
    expect(first.phase).toBe("plan");
    expect(first.ts).toBeTruthy();
  });

  it("names one file per UTC day", () => {
    expect(llmLogFile(new Date("2026-01-05T23:30:00Z"))).toBe("llm-2026-01-05.jsonl");
    expect(llmLogFile(new Date("2026-01-06T00:30:00Z"))).toBe("llm-2026-01-06.jsonl");
  });

  it("keeps writing when the directory disappears mid-run", () => {
    const dir = tempLogDir();
    initLlmLog(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(() => logLlm({ event: "http", url: "https://x.test/v1" })).not.toThrow();
  });

  it("prunes log files older than the retention window", () => {
    const dir = tempLogDir();
    const stale = join(dir, "llm-2020-01-01.jsonl");
    const fresh = join(dir, llmLogFile());
    writeFileSync(stale, "{}\n", "utf8");
    writeFileSync(fresh, "{}\n", "utf8");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    initLlmLog(dir);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("log helpers", () => {
  it("strips query strings from URLs", () => {
    expect(sanitizeUrl("https://api.test/v1/chat/completions?key=secret")).toBe(
      "https://api.test/v1/chat/completions",
    );
    expect(sanitizeUrl("not a url")).toBe("not a url");
  });

  it("clips long previews with a marker", () => {
    expect(clipPreview("abc", 5)).toBe("abc");
    const clipped = clipPreview("abcdef", 3);
    expect(clipped.startsWith("abc")).toBe(true);
    expect(clipped).toContain("clipped");
  });
});
