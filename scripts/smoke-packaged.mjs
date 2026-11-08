#!/usr/bin/env node
/**
 * Launch an unpacked Jin build with JIN_SMOKE_TEST=1 and fail unless the main
 * process reports that the renderer, preload bridge and app version loaded.
 *
 * Usage:
 *   node scripts/smoke-packaged.mjs [path-to-unpacked-app]
 *   JIN_SMOKE_APP=/path/to/jin node scripts/smoke-packaged.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const TIMEOUT_MS = 90_000;
const MAX_OUTPUT = 200_000;

function walk(dir, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, depth + 1));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Find the newest unpacked executable produced by electron-builder. */
function findExecutable() {
  const explicit = process.env.JIN_SMOKE_APP;
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error(`JIN_SMOKE_APP does not exist: ${path}`);
    return path;
  }

  const releaseRoot = resolve("release");
  if (!existsSync(releaseRoot)) {
    throw new Error("release/ does not exist; run `pnpm pack:dir` first");
  }
  const candidates = walk(releaseRoot)
    .filter((path) => {
      if (process.platform === "darwin") {
        return (
          path.includes(".app/Contents/MacOS/") &&
          basename(path) === "Jin" &&
          statSync(path).mode & 0o111
        );
      }
      if (process.platform === "win32") {
        return basename(path) === "Jin.exe";
      }
      return basename(path) === "jin" && path.includes("linux-unpacked");
    })
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  if (candidates.length === 0) {
    throw new Error(
      `No unpacked ${process.platform} executable found under release/; run \`pnpm pack:dir\``,
    );
  }
  return candidates[0];
}

function main() {
  const executable = findExecutable();
  const smokeUserData = mkdtempSync(join(tmpdir(), "jin-packaged-smoke-"));
  const args = [];
  args.push(`--user-data-dir=${smokeUserData}`);
  if (process.platform === "linux") {
    // CI containers and headless runners often lack a configured SUID sandbox.
    args.push("--no-sandbox", "--disable-gpu");
  }

  console.log(`[smoke] ${executable}`);
  const env = {
    ...process.env,
    JIN_SMOKE_TEST: "1",
    ELECTRON_ENABLE_LOGGING: "1",
  };
  delete env.JIN_DEBUG_PORT;

  const child = spawn(executable, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk) => {
    if (output.length >= MAX_OUTPUT) return;
    output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let settled = false;
  const finish = (success, code, detail) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (success) {
      console.log(`[smoke] PASS: ${detail}`);
    } else {
      console.error(`[smoke] FAIL (exit ${code}): ${detail}`);
      if (output.trim()) console.error(output.trim());
    }
    const cleanup = () => rmSync(smokeUserData, { recursive: true, force: true });
    const exitAfterCleanup = () => {
      cleanup();
      setTimeout(() => process.exit(success ? 0 : 1), 150);
    };
    if (child.exitCode !== null || child.signalCode !== null) exitAfterCleanup();
    else child.once("close", exitAfterCleanup);
  };

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(false, "timeout", `packaged app did not finish within ${TIMEOUT_MS}ms`);
  }, TIMEOUT_MS);
  timer.unref?.();

  child.on("error", (error) => finish(false, "spawn", error.message));
  child.on("close", (code) => {
    const ok = output.includes("JIN_SMOKE_OK");
    if (code === 0 && ok) {
      const line = output
        .split("\n")
        .find((entry) => entry.includes("JIN_SMOKE_OK"));
      finish(true, 0, line?.trim() ?? "renderer and preload bridge loaded");
    } else {
      finish(
        false,
        code ?? "signal",
        ok
          ? "smoke reported OK but the process exited non-zero"
          : "JIN_SMOKE_OK was not reported",
      );
    }
  });
}

main();
