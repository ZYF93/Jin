import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function isRepository(root: string): Promise<boolean> {
  try {
    const out = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Create a checkpoint of the current working tree without touching HEAD, the
 * index or the working directory. `git stash create` writes a dangling commit;
 * the caller stores the hash and can restore it later with `restoreCheckpoint`.
 * Returns null for a clean tree or a non-repository project.
 */
export async function createCheckpoint(
  root: string,
  message = "jin checkpoint",
): Promise<string | null> {
  if (!(await isRepository(root))) return null;
  try {
    const hash = (await git(root, ["stash", "create", message])).trim();
    return hash || null;
  } catch {
    // A dirty tree with only untracked files can make stash create fail; the
    // turn must not break because checkpointing is best-effort.
    return null;
  }
}

export interface RestoreResult {
  restored: number;
  warnings: string[];
}

/**
 * Restore files from a checkpoint commit into the working tree. HEAD is left
 * untouched, so the user can inspect the restored state and commit or discard
 * it deliberately. Files created after the checkpoint are not deleted.
 */
export async function restoreCheckpoint(root: string, hash: string): Promise<RestoreResult> {
  if (!(await isRepository(root))) throw new Error("This project is not a Git repository.");
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error("Invalid checkpoint id.");
  const warnings: string[] = [];
  const list = (await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", hash])).trim();
  const files = list ? list.split("\n").filter(Boolean) : [];
  if (files.length === 0) {
    // Merge commits (stash entries) need -m; fall back to the tree listing.
    const tree = (await git(root, ["ls-tree", "-r", "--name-only", hash])).trim();
    for (const file of tree ? tree.split("\n").filter(Boolean) : []) files.push(file);
  }
  if (files.length === 0) {
    return { restored: 0, warnings: ["The checkpoint has no files."] };
  }
  try {
    await git(root, ["restore", "--source", hash, "--worktree", "--", ...files]);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    // Fall back to checkout for older Git versions without `restore`.
    await git(root, ["checkout", hash, "--", ...files]);
  }
  return { restored: files.length, warnings };
}

/** Current short HEAD, used to show which commit a checkpoint belongs to. */
export async function currentCommit(root: string): Promise<string | null> {
  if (!(await isRepository(root))) return null;
  try {
    return (await git(root, ["rev-parse", "--short", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}
