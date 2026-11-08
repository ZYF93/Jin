import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { normalizeProjectPath } from "./path-safety";

export const DEFAULT_SHELL_TIMEOUT_MS = 15_000;
export const MAX_SHELL_TIMEOUT_MS = 30_000;
export const MAX_SHELL_OUTPUT_BYTES = 32 * 1024;

export interface ShellRunInput {
  root: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ShellRunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface ShellAuditEntry {
  command: string;
  cwd: string;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  truncated?: boolean;
  rejected?: string;
}

function shellWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

const DENIED_COMMANDS = new Set([
  "sudo",
  "su",
  "doas",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "mkfs",
  "mount",
  "umount",
  "diskutil",
  "reg",
  "format",
]);

const DENIED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(?:^|[\s;&|])rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/\s*(?:$|[;&|])/, reason: "recursive deletion of the filesystem root" },
  { pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*[fdx]|push\s+--force|push\s+-f)\b/, reason: "destructive Git history rewrite" },
  { pattern: /\bdd\s+[^\n]*\bof=/, reason: "raw disk writes" },
  { pattern: /:\(\)\s*\{/, reason: "fork bomb" },
  { pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|da)?sh\b/, reason: "piping a remote script into a shell" },
];

/**
 * Validate a shell command before it reaches the OS. This is a guardrail, not
 * an OS sandbox: commands may only use project-relative paths, and obviously
 * destructive commands are rejected. Every attempt is audited.
 */
export function validateShellCommand(
  command: string,
  root: string,
  cwd?: string,
): string {
  const clean = command.trim();
  if (!clean) throw new Error("Command is required");
  if (clean.includes("\0") || /[\r\n]/.test(clean)) {
    throw new Error("Commands must be a single line");
  }
  if (/(^|[\s"'=:(/])\.\.($|[/\s"')])/.test(clean)) {
    throw new Error("Parent-directory traversal is not allowed in shell commands");
  }
  if (/(^|[\s"'=:(])\/(?!\/)/.test(clean)) {
    throw new Error("Absolute paths are not allowed in shell commands; use project-relative paths");
  }
  if (/(^|[\s"'=:(])[A-Za-z]:[\\/]/.test(clean)) {
    throw new Error("Absolute paths are not allowed in shell commands; use project-relative paths");
  }
  if (/(^|[\s"'=:(])~(?=$|[/\s"')])/.test(clean) || /\$(?:\{HOME\}|HOME\b)|%USERPROFILE%/i.test(clean)) {
    throw new Error("Home-directory shortcuts are not allowed in shell commands");
  }
  const first = shellWord(clean).replace(/^["']|["']$/g, "");
  if (DENIED_COMMANDS.has(first)) {
    throw new Error(`Command is not allowed: ${first}`);
  }
  for (const denied of DENIED_PATTERNS) {
    if (denied.pattern.test(clean)) {
      throw new Error(`Command is not allowed: ${denied.reason}`);
    }
  }
  // Resolve and realpath the working directory so symlinks cannot escape root.
  const folder = cwd?.trim() && cwd.trim() !== "." ? normalizeProjectPath(cwd) : "";
  const absolute = folder ? resolve(root, folder) : resolve(root);
  const realRoot = realpathSync(root);
  const realFolder = existsSync(absolute) ? realpathSync(absolute) : absolute;
  const rel = relative(realRoot, realFolder);
  if (rel.startsWith("..") || (rel && rel.split(sep).includes(".."))) {
    throw new Error("Working directory must stay inside the project root");
  }
  if (!existsSync(realFolder)) {
    throw new Error(`Working directory does not exist: ${folder || "."}`);
  }
  return folder || ".";
}

export function auditShell(root: string, entry: ShellAuditEntry): void {
  try {
    const dir = join(root, ".jin", "cache");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "shell-audit.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch {
    // Audit is best effort; a read-only cache must not break the agent.
  }
}

function appendCapped(
  current: { text: string; truncated: boolean },
  chunk: string,
): void {
  if (current.truncated) return;
  const next = current.text + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_SHELL_OUTPUT_BYTES) {
    current.text = next;
    return;
  }
  current.text = Buffer.from(next, "utf8")
    .subarray(0, MAX_SHELL_OUTPUT_BYTES)
    .toString("utf8");
  current.truncated = true;
}

function killTree(child: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Run one bounded command inside the project. Output is capped, timeouts kill
 * the whole process group, and every call is appended to
 * `.jin/cache/shell-audit.jsonl`.
 */
export async function runShell(input: ShellRunInput): Promise<ShellRunResult> {
  const started = Date.now();
  let cwd: string;
  try {
    cwd = validateShellCommand(input.command, input.root, input.cwd);
  } catch (error) {
    auditShell(input.root, {
      command: input.command,
      cwd: input.cwd ?? ".",
      rejected: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const timeoutMs = Math.max(
    1_000,
    Math.min(
      MAX_SHELL_TIMEOUT_MS,
      Number.isFinite(input.timeoutMs) ? Math.round(input.timeoutMs as number) : DEFAULT_SHELL_TIMEOUT_MS,
    ),
  );
  const absoluteCwd = cwd === "." ? input.root : resolve(input.root, cwd);
  const command = input.command.trim();
  const isWindows = process.platform === "win32";
  const executable = isWindows ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
  const args = isWindows
    ? ["/d", "/s", "/c", command]
    : ["-c", command];

  return new Promise<ShellRunResult>((resolvePromise) => {
    const stdout = { text: "", truncated: false };
    const stderr = { text: "", truncated: false };
    let timedOut = false;
    let settled = false;
    const child = spawn(executable, args, {
      cwd: absoluteCwd,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        TERM: "dumb",
        GIT_PAGER: "cat",
        PAGER: "cat",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !isWindows,
    });
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - started;
      auditShell(input.root, {
        command,
        cwd,
        exitCode,
        durationMs,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
      resolvePromise({
        command,
        cwd,
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        durationMs,
      });
    };
    const onAbort = (): void => {
      timedOut = true;
      killTree(child);
      finish(null);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => appendCapped(stdout, chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => appendCapped(stderr, chunk.toString("utf8")));
    child.on("error", (error) => {
      appendCapped(stderr, error.message);
      finish(-1);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Format a shell result for a model tool response, keeping it compact. */
export function shellResultText(result: ShellRunResult): string {
  const header = [
    `$ ${result.command}`,
    `cwd: ${result.cwd}`,
    `exit: ${result.exitCode ?? "killed"}${result.timedOut ? " (timed out)" : ""}`,
    `${result.durationMs}ms${result.truncated ? " · output truncated" : ""}`,
  ].join("\n");
  const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return body ? `${header}\n\n${body}` : header;
}
