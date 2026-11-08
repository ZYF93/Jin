import {
  AlertTriangle,
  CircleDot,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ScanSearch,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useJin } from "../state/useJin";
import { useT } from "../lib/i18n";
import { BrandMark, Spinner } from "./ui";
import { formatCount, isReviewing, nextOrdinal, ordinalLabel } from "../lib/utils";

export function TopBar() {
  const t = useT();
  const app = useJin((state) => state.app);
  const gitStatus = useJin((state) => state.gitStatus);
  const busy = useJin((state) => state.busy);
  const intentsCollapsed = useJin((state) => state.intentsCollapsed);
  const toggleIntents = useJin((state) => state.toggleIntents);
  const openSettings = useJin((state) => state.openSettings);
  const scan = useJin((state) => state.scan);
  const refresh = useJin((state) => state.refresh);

  if (!app?.project) return null;
  const project = app.project;
  const reviewing = isReviewing(app.proposal);
  const nodes = app.snapshot ? Object.keys(app.snapshot.nodes).length : 0;
  const versions = app.snapshot ? Object.keys(app.snapshot.versions).length : 0;
  const scanBusy = busy === t("busy.scanning") || app.scan.phase === "scanning";

  return (
    <header className="glass z-30 flex h-[54px] shrink-0 items-center gap-3 border-x-0 border-t-0 px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <BrandMark size={28} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="max-w-[220px] truncate text-[12.5px] font-bold tracking-tight">
              {project.name}
            </span>
            {(gitStatus?.branch ?? project.gitBranch) ? (
              <span className="chip h-[19px] max-w-[150px] gap-1 px-1.5 text-[8.5px]">
                <GitBranch size={9} className="shrink-0" />
                <span className="truncate">{gitStatus?.branch ?? project.gitBranch}</span>
              </span>
            ) : null}
          </div>
          <div className="font-mono-ui flex items-center gap-1.5 truncate text-[8.5px] text-[var(--faint)]">
            <span className="truncate">{project.root}</span>
          </div>
        </div>
      </div>

      <div className="ml-2 hidden items-center gap-1.5 lg:flex">
        <span className="chip" title={t("topbar.nodes.title")}>
          {t("topbar.nodes", { display: formatCount(nodes), count: nodes })}
        </span>
        <span className="chip" title={t("topbar.versions.title")}>
          {t("topbar.versions", { display: formatCount(versions), count: versions })}
        </span>
        <span className="chip" title={t("topbar.wal.title")}>
          {t("topbar.wal", { display: formatCount(app.wal.records) })}
        </span>
        {app.wal.conflicts.length > 0 ? (
          <span className="chip chip-danger">
            <AlertTriangle size={9} />
            {t("topbar.conflicts", {
              display: formatCount(app.wal.conflicts.length),
              count: app.wal.conflicts.length,
            })}
          </span>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <div className="hidden items-center gap-1.5 md:flex">
          <span
            className={`chip ${
              app.scan.phase === "failed"
                ? "chip-danger"
                : reviewing
                  ? "chip-warning"
                  : "chip-success"
            }`}
            title={app.scan.message}
          >
            {scanBusy ? (
              <Spinner size={9} />
            ) : reviewing ? (
              <ShieldCheck size={9} />
            ) : (
              <CircleDot size={9} />
            )}
            {reviewing
              ? t("topbar.inReview", {
                  ordinal: ordinalLabel(nextOrdinal(app.snapshot)),
                })
              : app.scan.phase === "scanning"
                ? t("topbar.scanning")
                : app.scan.phase === "failed"
                  ? t("topbar.scanFailed")
                  : t("topbar.files", {
                      display: formatCount(app.scan.files),
                      count: app.scan.files,
                    })}
          </span>
        </div>
        <button
          className="btn btn-ghost h-8 px-2"
          onClick={() => void refresh()}
          disabled={Boolean(busy)}
          title={t("topbar.refresh.title")}
        >
          <RefreshCw size={13} />
          <span className="hidden xl:inline">{t("common.refresh")}</span>
        </button>
        <button
          className="btn h-8 px-2.5"
          onClick={() => void scan()}
          disabled={Boolean(busy) || reviewing}
          title={reviewing ? t("topbar.scan.blocked") : t("topbar.scan.title")}
        >
          {scanBusy ? <Spinner size={13} /> : <ScanSearch size={13} />}
          <span className="hidden sm:inline">{t("common.scan")}</span>
        </button>
        <span className="mx-0.5 h-5 w-px bg-[var(--border)]" />
        <button
          className={`icon-btn ${intentsCollapsed ? "" : "active"}`}
          onClick={toggleIntents}
          title={intentsCollapsed ? t("topbar.expandIntents") : t("topbar.collapseIntents")}
          aria-label={t("topbar.toggleIntents")}
        >
          {intentsCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
        <button
          className="icon-btn"
          onClick={() => openSettings("general")}
          title={t("topbar.settings")}
          aria-label={t("topbar.openSettings")}
        >
          <Settings size={15} />
        </button>
      </div>
    </header>
  );
}
