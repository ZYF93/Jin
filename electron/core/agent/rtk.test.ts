import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  configureRtkRuntime,
  rtkStatus,
  resolveRtkBinary,
  rewriteWithRtk,
  rtkPathEnv,
} from "./rtk";

const savedPath = process.env.PATH;
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  process.env.PATH = savedPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // Drop any cached lookups so PATH changes in the next test are honored.
  resolveRtkBinary(true);
});

describe("rtkStatus", () => {
  it("reports missing when RTK is not installed", () => {
    configureRtkRuntime(tempDir("jin-rtk-managed-"));
    const binDir = tempDir("jin-rtk-bin-");
    writeFileSync(join(binDir, "rtk"), "#!/bin/sh\nexit 1\n", "utf8");
    mkdirSync(binDir, { recursive: true });
    process.env.PATH = ""; // Isolate from any system RTK.
    const status = rtkStatus();
    expect(status.installed).toBe(false);
    expect(status.source ?? status.path).toBeNull();
  });
});

describe("resolveRtkBinary", () => {
  it("returns null path when nothing is found", () => {
    configureRtkRuntime(tempDir("jin-rtk-managed-"));
    process.env.PATH = "";
    const resolved = resolveRtkBinary(true);
    expect(resolved.path).toBeNull();
    expect(resolved.source).toBeNull();
  });
});

describe("rewriteWithRtk", () => {
  it("returns null when no RTK binary is available", () => {
    configureRtkRuntime(tempDir("jin-rtk-managed-"));
    process.env.PATH = "";
    const result = rewriteWithRtk(tempDir("jin-rtk-root-"), "git status");
    expect(result).toBeNull();
  });
});

describe("rtkPathEnv", () => {
  it("prepends the binary directory to PATH", () => {
    const env = rtkPathEnv("/opt/rtk/rtk");
    const [first] = env.split(":");
    expect(first).toBe("/opt/rtk");
  });
});
