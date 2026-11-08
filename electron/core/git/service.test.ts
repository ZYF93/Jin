import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitShow,
  gitStage,
  gitStatus,
  gitUnstage,
  isValidBranchName,
} from "./service";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jin-git-"));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.name", "Jin Test"]);
  git(root, ["config", "user.email", "jin@example.test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
}

function commitFile(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", message]);
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("gitStatus", () => {
  it("reports a non-repository without throwing", async () => {
    const root = tempRoot();
    const status = await gitStatus(root);
    expect(status.isRepo).toBe(false);
    expect(status.clean).toBe(true);
    expect(status.message).toBeTruthy();
  });

  it("tracks staged, unstaged, and untracked changes", async () => {
    const root = tempRoot();
    initRepo(root);
    writeFileSync(join(root, "alpha.txt"), "one\n");
    writeFileSync(join(root, "beta.txt"), "two\n");

    let status = await gitStatus(root);
    expect(status.untracked.map((change) => change.path)).toEqual(["alpha.txt", "beta.txt"]);

    await gitStage(root, ["alpha.txt"]);
    status = await gitStatus(root);
    expect(status.staged).toEqual([{ path: "alpha.txt", status: "A", staged: true }]);
    expect(status.untracked.map((change) => change.path)).toEqual(["beta.txt"]);

    await gitUnstage(root, ["alpha.txt"]);
    status = await gitStatus(root);
    expect(status.staged).toEqual([]);
    expect(status.untracked.map((change) => change.path)).toContain("alpha.txt");

    await gitStage(root);
    status = await gitStatus(root);
    expect(status.clean).toBe(false);
    expect(status.staged).toHaveLength(2);
  });

  it("rejects unsafe paths", async () => {
    const root = tempRoot();
    initRepo(root);
    await expect(gitStage(root, ["../escape.txt"])).rejects.toThrow(/unsafe/i);
    await expect(gitStage(root, ["/etc/passwd"])).rejects.toThrow(/unsafe/i);
  });
});

describe("commit history", () => {
  it("commits, reads log entries, and shows a patch", async () => {
    const root = tempRoot();
    initRepo(root);
    writeFileSync(join(root, "alpha.txt"), "hello\n");
    await expect(gitCommit(root, "nothing staged")).rejects.toThrow(/stage/i);

    await gitStage(root);
    const committed = await gitCommit(root, "initial commit");
    expect(committed.status.clean).toBe(true);
    expect(committed.message).toContain("initial commit");

    const log = await gitLog(root, 10);
    expect(log[0]).toMatchObject({ subject: "initial commit" });
    expect(log[0]?.shortHash).toHaveLength(7);

    const detail = await gitShow(root, log[0]!.hash);
    expect(detail.subject).toBe("initial commit");
    expect(detail.files).toEqual([{ status: "A", path: "alpha.txt" }]);
    expect(detail.patch).toContain("+hello");
    expect(detail.truncated).toBe(false);

    writeFileSync(join(root, "alpha.txt"), "hello again\n");
    await gitStage(root, ["alpha.txt"]);
    await gitCommit(root, "second commit");
    expect(await gitLog(root, 10)).toHaveLength(2);
  });

  it("requires a non-empty commit message", async () => {
    const root = tempRoot();
    initRepo(root);
    await expect(gitCommit(root, "   ")).rejects.toThrow(/message/i);
  });

  it("returns an empty history before the first commit", async () => {
    const root = tempRoot();
    initRepo(root);
    expect(await gitLog(root)).toEqual([]);
  });
});

describe("branches", () => {
  it("lists, creates, and switches local branches", async () => {
    const root = tempRoot();
    initRepo(root);
    writeFileSync(join(root, "alpha.txt"), "hello\n");
    commitFile(root, "initial");

    const initial = await gitBranches(root);
    const current = initial.current;
    expect(current).toBeTruthy();
    expect(initial.local.map((branch) => branch.name)).toContain(current);

    git(root, ["branch", "feature"]);
    const listed = await gitBranches(root);
    expect(listed.local).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "feature", current: false }),
        expect.objectContaining({ name: current, current: true }),
      ]),
    );

    const switched = await gitCheckout(root, "feature");
    expect(switched.status.branch).toBe("feature");

    const created = await gitCheckout(root, "topic", true);
    expect(created.status.branch).toBe("topic");
    expect((await gitBranches(root)).local.map((branch) => branch.name)).toEqual(
      expect.arrayContaining(["feature", "topic"]),
    );
  });

  it("creates a local tracking branch from a remote branch", async () => {
    const base = tempRoot();
    const bare = join(base, "remote.git");
    mkdirSync(bare, { recursive: true });
    execFileSync("git", ["init", "--bare", bare], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    const work = join(base, "work");
    initRepo(work);
    writeFileSync(join(work, "file.txt"), "base\n");
    commitFile(work, "initial");
    const baseBranch = git(work, ["branch", "--show-current"]).trim();
    git(work, ["remote", "add", "origin", bare]);
    git(work, ["push", "-u", "origin", "HEAD"]);
    git(work, ["switch", "-c", "feature"]);
    writeFileSync(join(work, "feature.txt"), "feature\n");
    commitFile(work, "feature");
    git(work, ["push", "-u", "origin", "feature"]);
    git(work, ["switch", baseBranch]);
    git(work, ["branch", "-D", "feature"]);
    await gitFetch(work);

    const listed = await gitBranches(work);
    expect(listed.remote.map((branch) => branch.name)).toContain("origin/feature");
    expect(listed.local.map((branch) => branch.name)).not.toContain("feature");

    const switched = await gitCheckout(work, "origin/feature");
    expect(switched.status.branch).toBe("feature");
    expect(switched.status.upstream).toBe("origin/feature");
  });

  it("rejects unsafe branch names", async () => {
    const root = tempRoot();
    initRepo(root);
    for (const name of [
      "-danger",
      "has space",
      "two..dots",
      "double//slash",
      "/absolute",
      "branch.lock",
      "@{upstream}",
    ]) {
      expect(isValidBranchName(name)).toBe(false);
      await expect(gitCheckout(root, name)).rejects.toThrow(/branch/i);
    }
    expect(isValidBranchName("feature/nested-name")).toBe(true);
  });

  it("requires an explicit choice for dirty worktrees and preserves carried edits", async () => {
    const root = tempRoot();
    initRepo(root);
    writeFileSync(join(root, "alpha.txt"), "hello\n");
    commitFile(root, "initial");
    git(root, ["branch", "feature"]);
    writeFileSync(join(root, "alpha.txt"), "local edit\n");

    await expect(gitCheckout(root, "feature")).rejects.toThrow(/choose/i);
    const switched = await gitCheckout(root, "feature", false, "carry");
    expect(switched.status.branch).toBe("feature");
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("local edit\n");
  });

  it("saves tracked and untracked changes before switching when requested", async () => {
    const root = tempRoot();
    initRepo(root);
    writeFileSync(join(root, "alpha.txt"), "hello\n");
    commitFile(root, "initial");
    git(root, ["branch", "feature"]);
    writeFileSync(join(root, "alpha.txt"), "local edit\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");

    const switched = await gitCheckout(root, "feature", false, "stash");
    expect(switched.status.branch).toBe("feature");
    expect(switched.message).toMatch(/stash/i);
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("hello\n");
    expect(() => readFileSync(join(root, "new.txt"), "utf8")).toThrow();
    expect(git(root, ["stash", "list", "--format=%s"])).toMatch(/Jin branch switch: feature/);
  });
});

describe("remote operations", () => {
  it("pushes a new branch, sets upstream, fetches, and fast-forwards a pull", async () => {
    const base = tempRoot();
    const bare = join(base, "remote.git");
    mkdirSync(bare, { recursive: true });
    execFileSync("git", ["init", "--bare", bare], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });

    const work = join(base, "work");
    initRepo(work);
    writeFileSync(join(work, "file.txt"), "from work\n");
    commitFile(work, "initial");
    git(work, ["remote", "add", "origin", bare]);

    const pushed = await gitPush(work);
    expect(pushed.status.isRepo).toBe(true);
    expect(pushed.status.upstream).toBeTruthy();
    expect(pushed.status.ahead).toBe(0);
    expect(await gitFetch(work)).toBeTruthy();

    const clone = join(base, "clone");
    git(base, ["clone", bare, clone]);
    git(clone, ["config", "user.name", "Other"]);
    git(clone, ["config", "user.email", "other@example.test"]);
    git(clone, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(clone, "file.txt"), "from clone\n");
    commitFile(clone, "remote change");
    git(clone, ["push"]);
    await gitFetch(work);

    expect((await gitStatus(work)).behind).toBe(1);
    const pulled = await gitPull(work);
    expect(pulled.status.behind).toBe(0);
    expect(readFileSync(join(work, "file.txt"), "utf8")).toBe("from clone\n");
  });

  it("reports a missing remote instead of running a shell command", async () => {
    const root = tempRoot();
    initRepo(root);
    writeFileSync(join(root, "file.txt"), "x\n");
    commitFile(root, "initial");
    await expect(gitPush(root)).rejects.toThrow(/remote/i);
    await expect(gitPull(root)).rejects.toThrow(/upstream/i);
  });
});
