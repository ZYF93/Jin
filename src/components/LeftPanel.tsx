import {
  ChevronLeft,
  FileCode2,
  Layers3,
  Settings,
  Sparkles,
} from "lucide-react";
import { useJin } from "../state/useJin";
import { FilePanel } from "./FilePanel";
import { IntentPanel } from "./IntentPanel";

export function LeftPanel() {
  const app = useJin((state) => state.app);
  const collapsed = useJin((state) => state.intentsCollapsed);
  const leftTab = useJin((state) => state.leftTab);
  const setLeftTab = useJin((state) => state.setLeftTab);
  const setIntentsCollapsed = useJin((state) => state.setIntentsCollapsed);
  const openSettings = useJin((state) => state.openSettings);

  const proposal = app?.proposal;
  const versionCount = app?.snapshot ? Object.keys(app.snapshot.versions).length : 0;

  if (collapsed) {
    return (
      <aside className="rail flex shrink-0 flex-col items-center gap-1 py-2">
        <button
          className="rail-btn mb-1"
          onClick={() => {
            setLeftTab("intents");
            setIntentsCollapsed(false);
          }}
          title="Expand intents"
        >
          <Layers3 size={17} />
          {proposal && (proposal.status === "in_review" || proposal.status === "stale") ? (
            <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
          ) : null}
        </button>
        <button
          className={`rail-btn ${leftTab === "files" ? "active" : ""}`}
          onClick={() => {
            setLeftTab("files");
            setIntentsCollapsed(false);
          }}
          title="Files"
        >
          <FileCode2 size={16} />
        </button>
        <div className="my-1 h-px w-6 bg-[var(--border)]" />
        <button
          className="rail-btn"
          onClick={() => openSettings("tools")}
          title="Tools & language servers"
        >
          <Sparkles size={15} />
        </button>
        <div className="mt-auto">
          <button className="rail-btn" onClick={() => openSettings("general")} title="Settings">
            <Settings size={16} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="glass flex w-[332px] shrink-0 flex-col overflow-hidden border-y-0 border-l-0 2xl:w-[356px]">
      <div className="flex h-[39px] shrink-0 items-center gap-0 border-b border-[var(--border)] px-1.5">
        <button
          className={`tab ${leftTab === "intents" ? "active" : ""}`}
          onClick={() => setLeftTab("intents")}
        >
          <Layers3 size={12} />
          Intents
          <span className="font-mono-ui text-[8px] text-[var(--faint)]">{versionCount}</span>
        </button>
        <button
          className={`tab ${leftTab === "files" ? "active" : ""}`}
          onClick={() => setLeftTab("files")}
        >
          <FileCode2 size={12} />
          Files
        </button>
        <button
          className="icon-btn ml-auto h-7 w-7"
          onClick={() => setIntentsCollapsed(true)}
          title="Collapse intent panel"
          aria-label="Collapse intent panel"
        >
          <ChevronLeft size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {leftTab === "intents" ? <IntentPanel /> : <FilePanel />}
      </div>
    </aside>
  );
}
