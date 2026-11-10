import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { StagedFileEdit } from "./file-transaction";

const COPY_EXCLUDES = new Set([
  ".git",
  ".jin",
  "node_modules",
  "dist",
  "dist-electron",
  "release",
  "coverage",
  ".turbo",
  ".next",
  ".vite",
  "target",
  "build",
  "out",
]);

/** Create a private source snapshot for one implementation run. */
export function createImplementationWorkspace(projectRoot: string): string {
  const source = resolve(projectRoot);
  const parent = mkdtempSync(join(tmpdir(), "jin-agent-"));
  const workspace = join(parent, basename(source));
  try {
    cpSync(source, workspace, {
      recursive: true,
      dereference: false,
      filter: (path) => {
        if (path === source) return true;
        try {
          if (lstatSync(path).isSymbolicLink()) return false;
        } catch {
          return false;
        }
        const relative = path.slice(source.length).replace(/^[\\/]+/, "");
        const first = relative.split(/[\\/]/, 1)[0] ?? "";
        return !COPY_EXCLUDES.has(first);
      },
    });
    const modules = join(source, "node_modules");
    if (existsSync(modules)) {
      symlinkSync(
        modules,
        join(workspace, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    return workspace;
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

export function disposeImplementationWorkspace(workspace: string): void {
  rmSync(join(workspace, ".."), { recursive: true, force: true });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal?.aborted) {
      reject(new Error("Implementation cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveWait();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Implementation cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function removeStaleLock(lockPath: string): void {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const owner = JSON.parse(raw) as { pid?: unknown };
    if (typeof owner.pid === "number" && Number.isInteger(owner.pid)) {
      try {
        process.kill(owner.pid, 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      }
    } else if (Date.now() - statSync(lockPath).mtimeMs < 120_000) {
      return;
    }
    unlinkSync(lockPath);
  } catch {
    // Another process may have removed the stale lock while it was inspected.
  }
}

export function assertIntegrationBaselines(
  edits: readonly StagedFileEdit[],
  readCurrent: (edit: StagedFileEdit) => { exists: boolean; content: string },
): void {
  for (const edit of edits) {
    const current = readCurrent(edit);
    if (current.exists !== edit.originalExists || current.content !== edit.originalContent) {
      throw new Error(
        `Implementation conflict: ${edit.path} changed while the agent was working. Retry against the latest source.`,
      );
    }
  }
}

/** Serialize the short final integration phase across sessions/processes. */
export async function withProjectWriteLock<T>(
  projectRoot: string,
  signal: AbortSignal,
  operation: () => T | Promise<T>,
): Promise<T> {
  const cache = join(projectRoot, ".jin", "cache");
  mkdirSync(cache, { recursive: true });
  const lockPath = join(cache, "implementation-write.lock");
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + 120_000;
  let descriptor: number | null = null;
  while (descriptor === null) {
    if (signal.aborted) throw new Error("Implementation cancelled");
    try {
      const acquired = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(acquired, JSON.stringify({ token, pid: process.pid }));
        descriptor = acquired;
      } catch (error) {
        closeSync(acquired);
        unlinkSync(lockPath);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for another implementation to finish integrating.");
      }
      await wait(100, signal);
    }
  }
  closeSync(descriptor);
  try {
    if (signal.aborted) throw new Error("Implementation cancelled");
    return await operation();
  } finally {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
      if (lock.token === token) unlinkSync(lockPath);
    } catch {
      // A stale or externally removed lock needs no cleanup.
    }
  }
}
