import { execFile } from "node:child_process";
import { isValidBranchName } from "../../../shared/git";
import type {
  GitActionResult,
  GitBranch,
  GitBranchList,
  GitChange,
  GitCommit,
  GitCommitDetail,
  GitDirtyCheckoutAction,
  GitStatus,
} from "../../../shared/ipc";

export { isValidBranchName };

const DEFAULT_TIMEOUT_MS = 20_000;
const NETWORK_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_PATCH_CHARS = 180_000;
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

function run(
  root: string,
  args: string[],
  options: { timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotePath=false", "-C", root, ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: {
          ...process.env,
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        const result = {
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: error ? Number((error as { code?: number }).code ?? 1) : 0,
        };
        if (error && !options.allowFailure) {
          const detail = result.stderr.trim() || result.stdout.trim() || error.message;
          reject(
            new GitError(
              (error as { killed?: boolean }).killed
                ? `Git command timed out after ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s.`
                : detail,
            ),
          );
          return;
        }
        resolve(result);
      },
    );
  });
}

function cleanRelativePath(value: string): string {
  const clean = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    !clean ||
    clean.includes("\0") ||
    clean.startsWith("/") ||
    /^[A-Za-z]:\//.test(clean) ||
    clean.split("/").some((part) => part === "..")
  ) {
    throw new GitError(`Unsafe Git path: ${value}`);
  }
  return clean;
}

function cleanPaths(paths: readonly string[] | undefined): string[] {
  return [...new Set((paths ?? []).map(cleanRelativePath))];
}

function parseBranchLine(line: string | undefined): {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
} {
  if (!line) {
    return { branch: null, upstream: null, ahead: 0, behind: 0, detached: false };
  }
  const body = line.replace(/^##\s*/, "").trim();
  if (/^HEAD \(no branch\)/i.test(body)) {
    return { branch: null, upstream: null, ahead: 0, behind: 0, detached: true };
  }
  const noCommits = /^(?:No commits yet on|Initial commit on)\s+(.+)$/i.exec(body);
  if (noCommits?.[1]) {
    return {
      branch: noCommits[1].trim(),
      upstream: null,
      ahead: 0,
      behind: 0,
      detached: false,
    };
  }
  const [tracking = "", suffix = ""] = body.split(/\s+\[/, 2);
  const cleanTracking = tracking.replace(/\]$/, "");
  const [branchPart, upstreamPart] = cleanTracking.split("...", 2);
  const ahead = /ahead (\d+)/.exec(suffix)?.[1];
  const behind = /behind (\d+)/.exec(suffix)?.[1];
  return {
    branch: branchPart?.trim() || null,
    upstream: upstreamPart?.trim() || null,
    ahead: ahead ? Number(ahead) : 0,
    behind: behind ? Number(behind) : 0,
    detached: false,
  };
}

function parsePorcelain(
  output: string,
  branch: ReturnType<typeof parseBranchLine>,
): Omit<GitStatus, "root" | "remotes" | "message" | "isRepo"> {
  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  const untracked: GitChange[] = [];
  const conflicted: GitChange[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line || line.startsWith("## ")) continue;
    if (line.length < 4) continue;
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    let path = line.slice(3).trim();
    const rename = path.lastIndexOf(" -> ");
    if (rename >= 0) path = path.slice(rename + 4);
    if (!path) continue;
    const code = `${index}${worktree}`;
    if (index === "?" && worktree === "?") {
      untracked.push({ path, status: "?", staged: false });
      continue;
    }
    if (CONFLICT_CODES.has(code) || index === "U" || worktree === "U") {
      conflicted.push({ path, status: "U", staged: false });
      continue;
    }
    if (index !== " " && index !== "?") {
      staged.push({ path, status: index, staged: true });
    }
    if (worktree !== " " && worktree !== "?") {
      unstaged.push({ path, status: worktree, staged: false });
    }
  }
  const byPath = (left: GitChange, right: GitChange): number => left.path.localeCompare(right.path);
  staged.sort(byPath);
  unstaged.sort(byPath);
  untracked.sort(byPath);
  conflicted.sort(byPath);
  return {
    branch: branch.branch,
    detached: branch.detached,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    clean:
      staged.length === 0 &&
      unstaged.length === 0 &&
      untracked.length === 0 &&
      conflicted.length === 0,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

export async function gitStatus(projectRoot: string): Promise<GitStatus> {
  const top = await run(projectRoot, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  if (top.code !== 0 || !top.stdout.trim()) {
    return {
      isRepo: false,
      root: projectRoot,
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      clean: true,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
      remotes: [],
      message: top.stderr.trim() || "This folder is not a Git repository.",
    };
  }
  const root = top.stdout.trim();
  let branch = parseBranchLine(
    (await run(root, ["status", "--porcelain=v1", "--branch"])).stdout.split(/\r?\n/)[0],
  );
  if (branch.detached) {
    const short = await run(root, ["rev-parse", "--short", "HEAD"], {
      allowFailure: true,
    });
    branch = { ...branch, branch: short.stdout.trim() || null };
  }
  const status = await run(root, ["status", "--porcelain=v1", "--branch"]);
  const remotes = await run(root, ["remote"], { allowFailure: true });
  return {
    isRepo: true,
    root,
    ...parsePorcelain(status.stdout, branch),
    remotes: remotes.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    message: null,
  };
}

async function hasHead(root: string): Promise<boolean> {
  const head = await run(root, ["rev-parse", "--verify", "HEAD"], {
    allowFailure: true,
  });
  return head.code === 0;
}

/** List local branches and remote-tracking branches without changing the tree. */
export async function gitBranches(projectRoot: string): Promise<GitBranchList> {
  const status = await gitStatus(projectRoot);
  if (!status.isRepo) {
    return {
      current: null,
      detached: false,
      local: [],
      remote: [],
    };
  }
  const result = await run(
    status.root,
    ["for-each-ref", "--format=%(refname)%09%(HEAD)%09%(symref)", "refs/heads", "refs/remotes"],
    { allowFailure: true },
  );
  const local: GitBranch[] = [];
  const remote: GitBranch[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref = "", head = "", symref = ""] = line.split("\t");
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      if (!name) continue;
      local.push({
        name,
        current: head.trim() === "*" || name === status.branch,
        remote: false,
      });
    } else if (ref.startsWith("refs/remotes/")) {
      // origin/HEAD and other symbolic refs are aliases, not checkout targets.
      if (symref.trim()) continue;
      const name = ref.slice("refs/remotes/".length);
      if (!name || name.endsWith("/HEAD")) continue;
      remote.push({ name, current: false, remote: true });
    }
  }
  if (!status.detached && status.branch && !local.some((branch) => branch.name === status.branch)) {
    local.push({ name: status.branch, current: true, remote: false });
  }
  const byName = (left: GitBranch, right: GitBranch): number => left.name.localeCompare(right.name);
  local.sort(byName);
  remote.sort(byName);
  return {
    current: status.branch,
    detached: status.detached,
    local,
    remote,
  };
}

function localNameForRemote(name: string, remotes: readonly string[]): string {
  const remote = [...remotes]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => name.startsWith(`${candidate}/`));
  return remote ? name.slice(remote.length + 1) : name.slice(name.indexOf("/") + 1);
}

/**
 * Switch branches. Remote-tracking branches are converted into a local
 * tracking branch on first checkout so the working tree never ends up in a
 * detached HEAD by accident.
 */
export async function gitCheckout(
  projectRoot: string,
  branch: string,
  create = false,
  dirtyAction?: GitDirtyCheckoutAction,
): Promise<GitActionResult> {
  const name = branch.trim();
  if (!isValidBranchName(name)) throw new GitError("Invalid branch name.");
  const status = await gitStatus(projectRoot);
  if (!status.isRepo) throw new GitError(status.message ?? "Not a Git repository.");
  if (!status.clean) {
    if (!dirtyAction) {
      throw new GitError(
        "Working tree has changes. Choose whether to carry them or save them to a Git stash.",
      );
    }
  }
  let stashSaved = false;
  const prepareDirtyTree = async (): Promise<void> => {
    if (!status.clean && dirtyAction === "stash") {
      await run(status.root, [
        "stash",
        "push",
        "--include-untracked",
        "-m",
        `Jin branch switch: ${name}`,
      ]);
      stashSaved = true;
    }
  };

  const switched = async (message: string): Promise<GitActionResult> => ({
    status: await gitStatus(projectRoot),
    message: stashSaved ? `${message} Your changes are saved in Git stash.` : message,
  });

  if (create) {
    await prepareDirtyTree();
    await run(status.root, ["switch", "-c", name]);
    return switched(`Created ${name} and switched to it.`);
  }

  const branches = await gitBranches(projectRoot);
  const remoteBranch = branches.remote.find((candidate) => candidate.name === name);
  if (remoteBranch) {
    const localName = localNameForRemote(name, status.remotes);
    if (!isValidBranchName(localName)) throw new GitError("Invalid branch name.");
    const localBranch = branches.local.find((candidate) => candidate.name === localName);
    if (localBranch) {
      await prepareDirtyTree();
      await run(status.root, ["switch", localName]);
      return switched(`Switched to ${localName}.`);
    }
    await prepareDirtyTree();
    await run(status.root, ["switch", "-c", localName, "--track", name]);
    return switched(`Checked out ${localName} tracking ${name}.`);
  }

  await prepareDirtyTree();
  await run(status.root, ["switch", name]);
  return switched(`Switched to ${name}.`);
}

export async function gitStage(
  projectRoot: string,
  paths?: readonly string[],
): Promise<GitActionResult> {
  const current = await gitStatus(projectRoot);
  if (!current.isRepo) throw new GitError(current.message ?? "Not a Git repository.");
  const selected = cleanPaths(paths);
  await run(current.root, selected.length > 0 ? ["add", "--", ...selected] : ["add", "-A"]);
  return {
    status: await gitStatus(projectRoot),
    message:
      selected.length > 0
        ? `Staged ${selected.length} path${selected.length === 1 ? "" : "s"}.`
        : "Staged all changes.",
  };
}

export async function gitUnstage(
  projectRoot: string,
  paths?: readonly string[],
): Promise<GitActionResult> {
  const current = await gitStatus(projectRoot);
  if (!current.isRepo) throw new GitError(current.message ?? "Not a Git repository.");
  const selected = cleanPaths(paths);
  if (await hasHead(current.root)) {
    await run(current.root, ["restore", "--staged", "--", ...(selected.length ? selected : ["."])]);
  } else {
    await run(current.root, [
      "rm",
      "--cached",
      "-r",
      "--",
      ...(selected.length ? selected : ["."]),
    ]);
  }
  return {
    status: await gitStatus(projectRoot),
    message:
      selected.length > 0
        ? `Unstaged ${selected.length} path${selected.length === 1 ? "" : "s"}.`
        : "Unstaged all changes.",
  };
}

export async function gitCommit(projectRoot: string, message: string): Promise<GitActionResult> {
  const clean = message.trim();
  if (!clean) throw new GitError("A commit message is required.");
  if (clean.length > 5_000) throw new GitError("The commit message is too long.");
  if (clean.includes("\0")) throw new GitError("The commit message contains an invalid character.");
  const before = await gitStatus(projectRoot);
  if (!before.isRepo) throw new GitError(before.message ?? "Not a Git repository.");
  if (before.staged.length === 0 && before.conflicted.length === 0) {
    throw new GitError("Stage at least one change before committing.");
  }
  const result = await run(before.root, ["commit", "-m", clean]);
  const firstLine = result.stdout.trim().split(/\r?\n/)[0];
  return {
    status: await gitStatus(projectRoot),
    message: firstLine || "Committed staged changes.",
  };
}

export async function gitPush(projectRoot: string): Promise<GitActionResult> {
  const status = await gitStatus(projectRoot);
  if (!status.isRepo) throw new GitError(status.message ?? "Not a Git repository.");
  if (!status.branch) throw new GitError("Cannot push from a detached HEAD.");
  if (status.remotes.length === 0) throw new GitError("No Git remote is configured.");
  const remote =
    status.upstream?.split("/")[0] ||
    (status.remotes.includes("origin") ? "origin" : status.remotes[0]);
  if (!remote) throw new GitError("No Git remote is configured.");
  const args = status.upstream ? ["push"] : ["push", "--set-upstream", remote, status.branch];
  await run(status.root, args, { timeoutMs: NETWORK_TIMEOUT_MS });
  return {
    status: await gitStatus(projectRoot),
    message: status.upstream
      ? `Pushed ${status.branch}.`
      : `Pushed ${status.branch} and set upstream to ${remote}/${status.branch}.`,
  };
}

export async function gitPull(projectRoot: string): Promise<GitActionResult> {
  const status = await gitStatus(projectRoot);
  if (!status.isRepo) throw new GitError(status.message ?? "Not a Git repository.");
  if (!status.upstream) throw new GitError("This branch has no upstream to pull from.");
  await run(status.root, ["pull", "--ff-only"], { timeoutMs: NETWORK_TIMEOUT_MS });
  return {
    status: await gitStatus(projectRoot),
    message: `Pulled ${status.branch} from ${status.upstream}.`,
  };
}

export async function gitFetch(projectRoot: string): Promise<GitActionResult> {
  const status = await gitStatus(projectRoot);
  if (!status.isRepo) throw new GitError(status.message ?? "Not a Git repository.");
  if (status.remotes.length === 0) throw new GitError("No Git remote is configured.");
  await run(status.root, ["fetch", "--prune"], { timeoutMs: NETWORK_TIMEOUT_MS });
  return {
    status: await gitStatus(projectRoot),
    message: "Fetched remote refs.",
  };
}

export async function gitLog(projectRoot: string, limit = 30): Promise<GitCommit[]> {
  const status = await gitStatus(projectRoot);
  if (!status.isRepo) return [];
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 30;
  const result = await run(
    status.root,
    [
      "log",
      `-n${count}`,
      "--date=iso-strict",
      "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e",
    ],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    if (/does not have any commits yet|unknown revision|bad revision/i.test(result.stderr)) {
      return [];
    }
    throw new GitError(result.stderr.trim() || "Could not read Git history.");
  }
  return result.stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, author, email, date, refs, subject] = record.split("\x1f");
      return {
        hash: hash ?? "",
        shortHash: shortHash ?? "",
        author: author ?? "",
        email: email ?? "",
        date: date ?? "",
        refs: (refs ?? "")
          .split(",")
          .map((ref) => ref.trim())
          .filter(Boolean),
        subject: subject ?? "",
      };
    })
    .filter((commit) => commit.hash);
}

function validHash(value: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(value.trim());
}

export async function gitShow(projectRoot: string, hash: string): Promise<GitCommitDetail> {
  const clean = hash.trim();
  if (!validHash(clean)) throw new GitError("Invalid commit hash.");
  const status = await gitStatus(projectRoot);
  if (!status.isRepo) throw new GitError(status.message ?? "Not a Git repository.");
  const metadata = await run(status.root, [
    "show",
    "-s",
    "--date=iso-strict",
    "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b",
    clean,
  ]);
  const [fullHash, shortHash, author, email, date, refs, subject, ...body] =
    metadata.stdout.split("\x1f");
  const fileList = await run(status.root, [
    "show",
    "--name-status",
    "--format=",
    "--no-color",
    clean,
  ]);
  const files = fileList.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = (parts[0] ?? "M").charAt(0);
      const path = parts.length > 2 ? parts[parts.length - 1] : parts[1];
      return { status, path: path ?? "" };
    })
    .filter((file) => file.path);
  const patchResult = await run(status.root, [
    "show",
    "--patch",
    "--format=",
    "--no-color",
    "--no-ext-diff",
    clean,
  ]);
  const fullPatch = patchResult.stdout;
  return {
    hash: fullHash ?? clean,
    shortHash: shortHash ?? clean.slice(0, 7),
    author: author ?? "",
    email: email ?? "",
    date: date ?? "",
    refs: (refs ?? "")
      .split(",")
      .map((ref) => ref.trim())
      .filter(Boolean),
    subject: subject ?? "",
    body: body.join("\x1f").trim(),
    files,
    patch:
      fullPatch.length > MAX_PATCH_CHARS
        ? `${fullPatch.slice(0, MAX_PATCH_CHARS)}\n\n… diff truncated …`
        : fullPatch,
    truncated: fullPatch.length > MAX_PATCH_CHARS,
  };
}
