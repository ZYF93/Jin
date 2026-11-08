import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  GitBranch,
  GitCommitHorizontal,
  History,
  Plus,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { isValidBranchName } from "../../shared/git";
import type { GitBranch as GitBranchInfo, GitChange } from "../../shared/ipc";
import { useT } from "../lib/i18n";
import { formatRelative } from "../lib/utils";
import { useJin } from "../state/useJin";
import { Modal, ModalHeader, Spinner } from "./ui";

type Mode = "changes" | "history";

function statusTone(status: string): string {
  if (status === "A" || status === "?") return "text-[var(--success)]";
  if (status === "D" || status === "U") return "text-[var(--danger)]";
  if (status === "R" || status === "C") return "text-[var(--violet)]";
  return "text-[var(--warning)]";
}

function ChangeRow({
  change,
  actionLabel,
  busy,
  onAction,
}: {
  change: GitChange;
  actionLabel: string;
  busy: boolean;
  onAction: (path: string) => void;
}) {
  return (
    <div className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-[var(--control)]">
      <span
        className={`font-mono-ui w-[14px] shrink-0 text-center text-[8px] font-bold ${statusTone(change.status)}`}
      >
        {change.status === "?" ? "U" : change.status}
      </span>
      <span
        className="min-w-0 flex-1 truncate font-mono-ui text-[9px] text-[var(--muted)]"
        title={change.path}
      >
        {change.path}
      </span>
      <button
        className="icon-btn h-5 w-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={() => onAction(change.path)}
        disabled={busy}
        title={actionLabel}
        aria-label={`${actionLabel}: ${change.path}`}
      >
        {actionLabel.includes("Unstage") || actionLabel.includes("取消") ? (
          <RotateCcw size={9} />
        ) : (
          <Check size={9} />
        )}
      </button>
    </div>
  );
}

function ChangeGroup({
  title,
  changes,
  actionLabel,
  allLabel,
  busy,
  onAction,
  onAll,
}: {
  title: string;
  changes: GitChange[];
  actionLabel: string;
  allLabel: string;
  busy: boolean;
  onAction: (path: string) => void;
  onAll: () => void;
}) {
  if (changes.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-1.5 px-1">
        <span className="text-[8.5px] font-semibold tracking-wide text-[var(--faint)] uppercase">
          {title}
        </span>
        <span className="font-mono-ui text-[8px] text-[var(--faint)]">{changes.length}</span>
        <button
          className="ml-auto text-[8px] text-[var(--muted)] hover:text-[var(--text)]"
          onClick={onAll}
          disabled={busy}
        >
          {allLabel}
        </button>
      </div>
      <div className="space-y-0.5">
        {changes.map((change) => (
          <ChangeRow
            key={`${change.staged ? "staged" : "work"}-${change.path}`}
            change={change}
            actionLabel={actionLabel}
            busy={busy}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

function CommitHistory() {
  const t = useT();
  const commits = useJin((state) => state.gitCommits);
  const detail = useJin((state) => state.gitDetail);
  const detailHash = useJin((state) => state.gitDetailHash);
  const detailLoading = useJin((state) => state.gitDetailLoading);
  const selectCommit = useJin((state) => state.selectGitCommit);

  if (detailHash) {
    return (
      <div className="space-y-2">
        <button
          className="flex items-center gap-1 text-[8.5px] text-[var(--muted)] hover:text-[var(--text)]"
          onClick={() => void selectCommit(null)}
        >
          <ChevronLeft size={10} /> {t("git.history")}
        </button>
        {detailLoading || !detail ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[9px] text-[var(--faint)]">
            <Spinner size={11} /> {t("git.loading")}
          </div>
        ) : (
          <>
            <div className="inner-panel p-2.5">
              <div className="font-mono-ui text-[9px] text-[var(--accent)]">{detail.shortHash}</div>
              <div className="mt-1 text-[10px] font-semibold break-words">{detail.subject}</div>
              {detail.body ? (
                <p className="mt-1 text-[8.5px] whitespace-pre-wrap text-[var(--muted)]">
                  {detail.body}
                </p>
              ) : null}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[8px] text-[var(--faint)]">
                <span>{detail.author}</span>
                <span>{formatRelative(detail.date)}</span>
                <span>{t("git.filesChanged", { count: detail.files.length })}</span>
              </div>
            </div>
            <pre className="max-h-[360px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] p-2 font-mono-ui text-[8px] leading-relaxed whitespace-pre text-[var(--muted)]">
              {detail.patch || t("git.detailEmpty")}
            </pre>
          </>
        )}
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-[9px] text-[var(--faint)]">
        {t("git.noHistory")}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      <div className="mb-1 px-1 text-[8px] text-[var(--faint)]">{t("git.historyHint")}</div>
      {commits.map((commit) => (
        <button
          key={commit.hash}
          className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-[var(--control)]"
          onClick={() => void selectCommit(commit.hash)}
        >
          <GitCommitHorizontal size={10} className="mt-0.5 shrink-0 text-[var(--violet)]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[9.5px] font-medium text-[var(--text)]">
              {commit.subject}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[7.5px] text-[var(--faint)]">
              <span className="font-mono-ui">{commit.shortHash}</span>
              <span>{formatRelative(commit.date)}</span>
              {commit.refs.slice(0, 2).map((ref) => (
                <span key={ref} className="chip h-[14px] px-1 text-[7px]">
                  {ref}
                </span>
              ))}
            </span>
          </span>
          <ChevronRight size={9} className="mt-1 shrink-0 text-[var(--faint)]" />
        </button>
      ))}
    </div>
  );
}

function BranchSection({
  title,
  branches,
  current,
  upstream,
  busy,
  onSwitch,
}: {
  title: string;
  branches: GitBranchInfo[];
  current: string | null;
  upstream: string | null;
  busy: boolean;
  onSwitch: (name: string) => void;
}) {
  if (branches.length === 0) return null;
  return (
    <div className="mb-1.5">
      <div className="px-1 py-0.5 text-[8px] font-semibold tracking-wide text-[var(--faint)] uppercase">
        {title}
      </div>
      {branches.map((branch) => {
        const active = branch.remote ? branch.name === upstream : branch.name === current;
        return (
          <button
            key={branch.name}
            className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left ${
              active
                ? "bg-[var(--accent-soft)] text-[var(--text)]"
                : "text-[var(--muted)] hover:bg-[var(--control)]"
            }`}
            onClick={() => onSwitch(branch.name)}
            disabled={busy || active}
            title={branch.name}
          >
            <GitBranch
              size={9}
              className={active ? "text-[var(--accent)]" : "text-[var(--faint)]"}
            />
            <span className="min-w-0 flex-1 truncate font-mono-ui text-[9px]">{branch.name}</span>
            {active ? <Check size={9} className="text-[var(--accent)]" /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function GitPanel() {
  const t = useT();
  const app = useJin((state) => state.app);
  const status = useJin((state) => state.gitStatus);
  const loading = useJin((state) => state.gitLoading);
  const action = useJin((state) => state.gitAction);
  const error = useJin((state) => state.gitError);
  const branches = useJin((state) => state.gitBranches);
  const branchesLoading = useJin((state) => state.gitBranchesLoading);
  const loadGit = useJin((state) => state.loadGit);
  const loadGitBranches = useJin((state) => state.loadGitBranches);
  const checkoutGit = useJin((state) => state.checkoutGit);
  const stageGit = useJin((state) => state.stageGit);
  const unstageGit = useJin((state) => state.unstageGit);
  const commitGit = useJin((state) => state.commitGit);
  const pushGit = useJin((state) => state.pushGit);
  const pullGit = useJin((state) => state.pullGit);
  const fetchGit = useJin((state) => state.fetchGit);
  const [mode, setMode] = useState<Mode>("changes");
  const [message, setMessage] = useState("");
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [pendingBranch, setPendingBranch] = useState<{ name: string; create: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (app?.project && !status && !loading) void loadGit();
  }, [app?.project, loadGit, loading, status]);

  const busy = Boolean(action);
  const staged = status?.staged.length ?? 0;
  const branchValid = isValidBranchName(newBranch);

  const commit = async (): Promise<void> => {
    const clean = message.trim();
    if (!clean || staged === 0 || busy) return;
    if (await commitGit(clean)) setMessage("");
  };

  const toggleBranches = (): void => {
    const next = !branchesOpen;
    setBranchesOpen(next);
    if (next) void loadGitBranches();
  };

  const switchBranch = async (name: string): Promise<void> => {
    if (busy) return;
    if (!status?.clean) {
      setPendingBranch({ name, create: false });
      return;
    }
    if (await checkoutGit(name)) {
      setBranchesOpen(false);
      setNewBranch("");
    }
  };

  const switchWithDirtyAction = async (dirtyAction: "carry" | "stash"): Promise<void> => {
    const target = pendingBranch;
    if (!target || busy) return;
    if (await checkoutGit(target.name, target.create, dirtyAction)) {
      setPendingBranch(null);
      setBranchesOpen(false);
      setNewBranch("");
    }
  };

  const changedPaths = [
    ...(status?.staged ?? []),
    ...(status?.unstaged ?? []),
    ...(status?.untracked ?? []),
    ...(status?.conflicted ?? []),
  ].filter(
    (change, index, all) => all.findIndex((candidate) => candidate.path === change.path) === index,
  );

  const createBranch = async (): Promise<void> => {
    const name = newBranch.trim();
    if (!branchValid || busy) return;
    if (!status?.clean) {
      setPendingBranch({ name, create: true });
      return;
    }
    if (await checkoutGit(name, true)) {
      setBranchesOpen(false);
      setNewBranch("");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Modal
        open={pendingBranch !== null}
        onClose={() => setPendingBranch(null)}
        label={t("git.dirtySwitchTitle")}
        className="max-w-[440px]"
      >
        <ModalHeader
          title={t("git.dirtySwitchTitle")}
          subtitle={t("git.dirtySwitchDescription", { branch: pendingBranch?.name ?? "" })}
          onClose={() => setPendingBranch(null)}
          icon={<CircleAlert size={16} />}
        />
        <div className="max-h-[220px] overflow-y-auto px-5 py-3">
          <div className="mb-2 text-[10px] text-[var(--muted)]">
            {t("git.dirtySwitchFiles", { count: changedPaths.length })}
          </div>
          <ul className="space-y-1">
            {changedPaths.map((change) => (
              <li
                key={change.path}
                className="truncate font-mono-ui text-[9px] text-[var(--text)]"
                title={change.path}
              >
                {change.path}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          <button
            className="btn h-8 text-[10px]"
            onClick={() => setPendingBranch(null)}
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button
            className="btn h-8 text-[10px]"
            onClick={() => void switchWithDirtyAction("stash")}
            disabled={busy}
          >
            {t("git.stashAndSwitch")}
          </button>
          <button
            className="btn btn-primary h-8 text-[10px]"
            onClick={() => void switchWithDirtyAction("carry")}
            disabled={busy}
          >
            {t("git.carryAndSwitch")}
          </button>
        </div>
      </Modal>
      <div className="relative shrink-0">
        <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2 py-1.5">
          <button
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
            onClick={toggleBranches}
            disabled={!status?.isRepo}
            title={t("git.switchBranch")}
            aria-label={t("git.switchBranch")}
            aria-expanded={branchesOpen}
          >
            <GitBranch size={10} className="shrink-0 text-[var(--violet)]" />
            <span className="min-w-0 flex-1 truncate font-mono-ui text-[9px] text-[var(--text)]">
              {status?.branch ?? (status?.detached ? t("git.detached") : t("git.title"))}
            </span>
            {status?.isRepo ? (
              <ChevronDown
                size={9}
                className={`shrink-0 text-[var(--faint)] transition-transform ${
                  branchesOpen ? "rotate-180" : ""
                }`}
              />
            ) : null}
          </button>
          {status?.upstream ? (
            <span className="chip h-[15px] max-w-[95px] truncate px-1 text-[7px]">
              {status.upstream}
            </span>
          ) : null}
          {status && status.ahead > 0 ? (
            <span className="chip chip-accent h-[15px] px-1 text-[7px]">↑{status.ahead}</span>
          ) : null}
          {status && status.behind > 0 ? (
            <span className="chip chip-warning h-[15px] px-1 text-[7px]">↓{status.behind}</span>
          ) : null}
          <button
            className="icon-btn h-6 w-6 shrink-0"
            onClick={() => void loadGit()}
            disabled={loading || busy}
            title={t("git.refresh")}
            aria-label={t("git.refresh")}
          >
            <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {branchesOpen && status?.isRepo ? (
          <div className="absolute inset-x-1 top-[calc(100%+4px)] z-40 rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] p-2 shadow-2xl">
            <div className="flex items-center gap-1.5 px-1">
              <span className="text-[8.5px] font-semibold tracking-wide text-[var(--faint)] uppercase">
                {t("git.branches")}
              </span>
              {branchesLoading ? <Spinner size={9} /> : null}
              <button
                className="icon-btn ml-auto h-5 w-5"
                onClick={() => void loadGitBranches()}
                disabled={branchesLoading}
                title={t("git.refresh")}
                aria-label={t("git.refresh")}
              >
                <RefreshCw size={9} />
              </button>
            </div>
            <div className="mt-1 max-h-[220px] overflow-y-auto">
              <BranchSection
                title={t("git.localBranches")}
                branches={branches?.local ?? []}
                current={branches?.current ?? status.branch}
                upstream={status.upstream}
                busy={busy}
                onSwitch={(name) => void switchBranch(name)}
              />
              <BranchSection
                title={t("git.remoteBranches")}
                branches={branches?.remote ?? []}
                current={branches?.current ?? status.branch}
                upstream={status.upstream}
                busy={busy}
                onSwitch={(name) => void switchBranch(name)}
              />
              {!branchesLoading &&
              (branches?.local.length ?? 0) === 0 &&
              (branches?.remote.length ?? 0) === 0 ? (
                <div className="px-1 py-2 text-[8.5px] text-[var(--faint)]">
                  {t("git.noBranches")}
                </div>
              ) : null}
            </div>
            <div className="mt-2 border-t border-[var(--border)] pt-2">
              <div className="label">{t("git.newBranch")}</div>
              <div className="flex gap-1.5">
                <input
                  className="field h-7 min-w-0 flex-1 font-mono-ui text-[9px]"
                  value={newBranch}
                  onChange={(event) => setNewBranch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void createBranch();
                    }
                  }}
                  placeholder={t("git.newBranchPlaceholder")}
                />
                <button
                  className="btn btn-primary h-7 shrink-0 text-[8.5px]"
                  onClick={() => void createBranch()}
                  disabled={!branchValid || busy}
                >
                  <Plus size={9} />
                  {t("git.createBranch")}
                </button>
              </div>
              {newBranch.trim() && !branchValid ? (
                <div className="mt-1 text-[8px] text-[var(--danger)]">{t("git.branchInvalid")}</div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] px-1.5 py-1">
        <button
          className={`tab ${mode === "changes" ? "active" : ""}`}
          onClick={() => setMode("changes")}
        >
          <GitCommitHorizontal size={11} />
          {t("git.changes")}
          {staged > 0 ? (
            <span className="font-mono-ui text-[8px] text-[var(--faint)]">{staged}</span>
          ) : null}
        </button>
        <button
          className={`tab ${mode === "history" ? "active" : ""}`}
          onClick={() => setMode("history")}
        >
          <History size={11} />
          {t("git.history")}
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            className="icon-btn h-6 w-6"
            onClick={() => void fetchGit()}
            disabled={busy || !status?.isRepo || status.remotes.length === 0}
            title={t("git.fetch")}
            aria-label={t("git.fetch")}
          >
            <RefreshCw size={10} className={action === t("git.fetch") ? "animate-spin" : ""} />
          </button>
          <button
            className="icon-btn h-6 w-6"
            onClick={() => void pullGit()}
            disabled={busy || !status?.upstream}
            title={t("git.pull")}
            aria-label={t("git.pull")}
          >
            <ArrowDownToLine size={10} />
          </button>
          <button
            className="icon-btn h-6 w-6"
            onClick={() => void pushGit()}
            disabled={busy || !status?.isRepo || !status.branch || status.remotes.length === 0}
            title={t("git.push")}
            aria-label={t("git.push")}
          >
            <ArrowUpFromLine size={10} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error ? (
          <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-rose-400/20 bg-rose-400/[0.05] px-2 py-1.5 text-[8.5px] text-[var(--muted)]">
            <CircleAlert size={10} className="mt-0.5 shrink-0 text-[var(--danger)]" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
          </div>
        ) : null}

        {loading && !status ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[9px] text-[var(--faint)]">
            <Spinner size={12} /> {t("git.loading")}
          </div>
        ) : !status ? (
          <div className="px-2 py-8 text-center text-[9px] text-[var(--faint)]">
            {app?.project ? t("git.loading") : t("chat.placeholder.none")}
          </div>
        ) : !status.isRepo ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] px-3 py-3 text-center">
            <CircleAlert size={15} className="mx-auto text-[var(--warning)]" />
            <div className="mt-1.5 text-[10px] font-semibold">{t("git.notRepo")}</div>
            <div className="mt-1 text-[8.5px] leading-relaxed text-[var(--faint)]">
              {t("git.notRepoHint")}
            </div>
            {status.message ? (
              <div className="mt-1.5 font-mono-ui text-[7.5px] break-words text-[var(--faint)]">
                {status.message}
              </div>
            ) : null}
          </div>
        ) : mode === "history" ? (
          <CommitHistory />
        ) : (
          <>
            {status.conflicted.length > 0 ? (
              <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-rose-400/25 bg-rose-400/[0.06] px-2 py-1.5 text-[8.5px] text-[var(--danger)]">
                <CircleAlert size={10} />
                {t("git.conflicted")}: {status.conflicted.length}
              </div>
            ) : null}

            {status.clean ? (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] px-3 py-4 text-center">
                <Check size={15} className="mx-auto text-[var(--success)]" />
                <div className="mt-1.5 text-[10px] font-semibold">{t("git.clean")}</div>
                <div className="mt-1 text-[8.5px] text-[var(--faint)]">{t("git.cleanHint")}</div>
              </div>
            ) : (
              <>
                <ChangeGroup
                  title={t("git.staged")}
                  changes={status.staged}
                  actionLabel={t("git.unstage")}
                  allLabel={t("git.unstageAll")}
                  busy={busy}
                  onAction={(path) => void unstageGit([path])}
                  onAll={() => void unstageGit()}
                />
                <ChangeGroup
                  title={t("git.unstaged")}
                  changes={status.unstaged}
                  actionLabel={t("git.stage")}
                  allLabel={t("git.stageAll")}
                  busy={busy}
                  onAction={(path) => void stageGit([path])}
                  onAll={() => void stageGit()}
                />
                <ChangeGroup
                  title={t("git.untracked")}
                  changes={status.untracked}
                  actionLabel={t("git.stage")}
                  allLabel={t("git.stageAll")}
                  busy={busy}
                  onAction={(path) => void stageGit([path])}
                  onAll={() => void stageGit()}
                />
                <ChangeGroup
                  title={t("git.conflicted")}
                  changes={status.conflicted}
                  actionLabel={t("git.stage")}
                  allLabel={t("git.stageAll")}
                  busy={busy}
                  onAction={(path) => void stageGit([path])}
                  onAll={() => void stageGit()}
                />
              </>
            )}

            <div className="mt-2 border-t border-[var(--border)] pt-2">
              <div className="label">{t("git.commitMessage")}</div>
              <textarea
                className="field min-h-[62px] resize-none text-[9.5px]"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={t("git.commitPlaceholder")}
              />
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[8px] text-[var(--faint)]">
                  {status.upstream
                    ? t("git.upstream", { name: status.upstream })
                    : t("git.noUpstream")}
                </span>
                <button
                  className="btn btn-primary h-7 text-[9px]"
                  onClick={() => void commit()}
                  disabled={busy || staged === 0 || !message.trim()}
                >
                  {action === t("git.commit") ? (
                    <Spinner size={9} />
                  ) : (
                    <GitCommitHorizontal size={9} />
                  )}
                  {t("git.commit")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {busy ? (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--border)] px-2 py-1 text-[8px] text-[var(--faint)]">
          <Spinner size={9} /> {t("git.working")} {action}
        </div>
      ) : null}
    </div>
  );
}
