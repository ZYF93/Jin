import { FileCode2, GitBranch, Layers3, Settings, Sparkles } from "lucide-react";
import { useT } from "../lib/i18n";
import { useJin } from "../state/useJin";
import { FilePanel } from "./FilePanel";
import { GitPanel } from "./GitPanel";
import { IntentPanel } from "./IntentPanel";

export function LeftPanel() {
  const t = useT();
  const app = useJin((state) => state.app);
  const collapsed = useJin((state) => state.intentsCollapsed);
  const leftTab = useJin((state) => state.leftTab);
  const setLeftTab = useJin((state) => state.setLeftTab);
  const setIntentsCollapsed = useJin((state) => state.setIntentsCollapsed);
  const openSettings = useJin((state) => state.openSettings);

  const proposal = app?.proposal;

  // Clicking the active activity collapses the content panel; the rail itself
  // always stays visible.
  const activate = (tab: "intents" | "files" | "git"): void => {
    if (leftTab === tab && !collapsed) {
      setIntentsCollapsed(true);
      return;
    }
    setLeftTab(tab);
    setIntentsCollapsed(false);
  };

  const titleFor = (tab: "intents" | "files" | "git", label: string): string =>
    leftTab === tab && !collapsed ? t("left.collapsePanel") : label;

  return (
    <div className="flex min-h-0 shrink-0">
      <aside className="rail flex shrink-0 flex-col items-center gap-1 py-2">
        <button
          className={`rail-btn mb-1 ${leftTab === "intents" && !collapsed ? "active" : ""}`}
          onClick={() => activate("intents")}
          title={titleFor("intents", t("left.intentsTab"))}
          aria-label={titleFor("intents", t("left.intentsTab"))}
        >
          <Layers3 size={17} />
          {proposal && (proposal.status === "in_review" || proposal.status === "stale") ? (
            <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
          ) : null}
        </button>
        <button
          className={`rail-btn ${leftTab === "files" && !collapsed ? "active" : ""}`}
          onClick={() => activate("files")}
          title={titleFor("files", t("left.files"))}
          aria-label={titleFor("files", t("left.files"))}
        >
          <FileCode2 size={16} />
        </button>
        <button
          className={`rail-btn ${leftTab === "git" && !collapsed ? "active" : ""}`}
          onClick={() => activate("git")}
          title={titleFor("git", t("left.git"))}
          aria-label={titleFor("git", t("left.git"))}
        >
          <GitBranch size={16} />
        </button>
        <div className="my-1 h-px w-6 bg-[var(--border)]" />
        <button className="rail-btn" onClick={() => openSettings("tools")} title={t("left.tools")}>
          <Sparkles size={15} />
        </button>
        <div className="mt-auto">
          <button
            className="rail-btn"
            onClick={() => openSettings("general")}
            title={t("left.settings")}
          >
            <Settings size={16} />
          </button>
        </div>
      </aside>

      {!collapsed ? (
        <aside className="glass flex w-[332px] shrink-0 flex-col overflow-hidden border-y-0 border-l-0 2xl:w-[356px]">
          <div className="min-h-0 flex-1 overflow-hidden">
            {leftTab === "intents" ? (
              <IntentPanel />
            ) : leftTab === "files" ? (
              <FilePanel />
            ) : (
              <GitPanel />
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
