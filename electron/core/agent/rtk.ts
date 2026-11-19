import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { RtkStatus } from "../../../shared/ipc";

const REWRITE_TIMEOUT_MS = 500;
const STATUS_TIMEOUT_MS = 2_000;
/** Negative lookups are cached briefly so a shell-heavy turn does not spawn a probe each time. */
const LOOKUP_TTL_MS = 30_000;

const binaryName = process.platform === "win32" ? "rtk.exe" : "rtk";

interface ResolvedBinary {
  path: string | null;
  source: RtkStatus["source"];
}

let managedDir: string | null = null;
let cached: { value: ResolvedBinary; at: number } | null = null;

/**
 * Point RTK lookup at the directory Jin installs into. Called once from the
 * main process; tests can leave it unset and rely on PATH alone.
 */
export function configureRtkRuntime(binDir: string): void {
  managedDir = binDir;
  cached = null;
}

/** Directory Jin-managed installs live in, or null before configuration. */
export function rtkInstallDir(): string | null {
  return managedDir;
}

function cleanEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TERM: "dumb",
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(): boolean {
  const probe = spawnSync(binaryName, ["--version"], {
    encoding: "utf8",
    timeout: STATUS_TIMEOUT_MS,
    windowsHide: true,
    env: cleanEnv(),
  });
  return !probe.error && probe.status === 0;
}

function managedBinary(): string | null {
  if (!managedDir) return null;
  const candidate = join(managedDir, binaryName);
  return existsSync(candidate) && isExecutable(candidate) ? candidate : null;
}

/**
 * Locate the RTK CLI: PATH first, then the copy Jin installed into its own
 * user-data directory. Cached for a short window so repeated shell calls do
 * not pay for a failed probe each time.
 */
export function resolveRtkBinary(force = false): ResolvedBinary {
  if (!force && cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.value;
  let value: ResolvedBinary = { path: null, source: null };
  if (onPath()) value = { path: binaryName, source: "path" };
  else {
    const managed = managedBinary();
    if (managed) value = { path: managed, source: "managed" };
  }
  cached = { value, at: Date.now() };
  return value;
}

export interface RtkRewrite {
  command: string;
  /** Resolved RTK binary, so the caller can put its folder on PATH. */
  binary: string;
}

/**
 * Ask RTK how it would rewrite a shell command. RTK exits 1 when it has
 * nothing to offer and 2 when its own rules deny the command; both mean "run
 * the original". Exit 3 is a rewrite that normally needs host approval — Jin
 * already approved the original command, so the rewrite is safe to run.
 * Returns null on any failure so a missing or broken RTK never changes what
 * the agent does.
 */
export function rewriteWithRtk(
  root: string,
  command: string,
  timeoutMs = REWRITE_TIMEOUT_MS,
): RtkRewrite | null {
  const binary = resolveRtkBinary();
  if (!binary.path) return null;
  try {
    const result = spawnSync(binary.path, ["rewrite", command], {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: cleanEnv(),
    });
    if (result.error) return null;
    if (result.status !== 0 && result.status !== 3) return null;
    const rewritten = result.stdout.trim();
    if (!rewritten || rewritten === command.trim()) return null;
    return { command: rewritten, binary: binary.path };
  } catch {
    return null;
  }
}

/** PATH for a spawned shell that must also see the RTK binary it was rewritten to call. */
export function rtkPathEnv(binary: string): string {
  return [dirname(binary), process.env.PATH].filter(Boolean).join(delimiter);
}

/**
 * Probe RTK for the settings UI. The version string also tells the real
 * project apart from the unrelated crate that shares its name.
 */
export function rtkStatus(): RtkStatus {
  const binary = resolveRtkBinary(true);
  if (!binary.path) return { installed: false, version: null, path: null, source: null };
  try {
    const result = spawnSync(binary.path, ["--version"], {
      encoding: "utf8",
      timeout: STATUS_TIMEOUT_MS,
      windowsHide: true,
      env: cleanEnv(),
    });
    const line = (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.trim() ?? "";
    if (result.error || result.status !== 0 || !line) {
      return { installed: false, version: null, path: binary.path, source: binary.source };
    }
    return { installed: true, version: line, path: binary.path, source: binary.source };
  } catch {
    return { installed: false, version: null, path: binary.path, source: binary.source };
  }
}
