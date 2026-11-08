import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ChevronRight,
  Command,
  FileCode2,
  FolderOpen,
  FolderPlus,
  GitPullRequest,
  Layers3,
  ListTree,
  PanelLeft,
  RefreshCw,
  ScanSearch,
  Settings,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { MessageKey } from "../../shared/i18n";
import { useLanguage, useT } from "../lib/i18n";
import { isReviewing } from "../lib/utils";
import { useJin } from "../state/useJin";

interface PaletteCommand {
  id: string;
  group: MessageKey;
  label: MessageKey;
  icon: typeof Command;
  shortcut?: string;
  enabled: boolean;
  run: () => void;
}

export function CommandPalette() {
  const t = useT();
  const language = useLanguage();
  const open = useJin((state) => state.commandOpen);
  const setOpen = useJin((state) => state.setCommandOpen);
  const app = useJin((state) => state.app);
  const openProject = useJin((state) => state.openProject);
  const createProject = useJin((state) => state.createProject);
  const closeProject = useJin((state) => state.closeProject);
  const scan = useJin((state) => state.scan);
  const refresh = useJin((state) => state.refresh);
  const setLeftTab = useJin((state) => state.setLeftTab);
  const setReviewOpen = useJin((state) => state.setReviewOpen);
  const approveProposal = useJin((state) => state.approveProposal);
  const rejectProposal = useJin((state) => state.rejectProposal);
  const expandAllL0 = useJin((state) => state.expandAllL0);
  const collapseAllL0 = useJin((state) => state.collapseAllL0);
  const openSettings = useJin((state) => state.openSettings);
  const toggleIntents = useJin((state) => state.toggleIntents);
  const saveSettings = useJin((state) => state.saveSettings);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasProject = Boolean(app?.project);
  const proposal = app?.proposal ?? null;
  const reviewing = isReviewing(proposal);
  const l0Ids = useMemo(
    () =>
      Object.values(app?.snapshot?.nodes ?? {})
        .filter((node) => node.level === "L0")
        .map((node) => node.id),
    [app?.snapshot],
  );

  const commands = useMemo<PaletteCommand[]>(() => {
    const run = (action: () => void) => () => {
      setOpen(false);
      action();
    };
    return [
      {
        id: "open-project",
        group: "command.group.project",
        label: "command.openProject",
        icon: FolderOpen,
        shortcut: "Ctrl/Cmd O",
        enabled: true,
        run: run(() => void openProject()),
      },
      {
        id: "new-project",
        group: "command.group.project",
        label: "command.newProject",
        icon: FolderPlus,
        shortcut: "Ctrl/Cmd Shift N",
        enabled: true,
        run: run(() => void createProject()),
      },
      {
        id: "close-project",
        group: "command.group.project",
        label: "command.closeProject",
        icon: XCircle,
        enabled: hasProject,
        run: run(() => void closeProject()),
      },
      {
        id: "scan",
        group: "command.group.project",
        label: "command.scan",
        icon: ScanSearch,
        shortcut: "Ctrl/Cmd Shift S",
        enabled: hasProject && !reviewing,
        run: run(() => void scan()),
      },
      {
        id: "refresh",
        group: "command.group.project",
        label: "command.refresh",
        icon: RefreshCw,
        enabled: hasProject,
        run: run(() => void refresh()),
      },
      {
        id: "intents",
        group: "command.group.navigate",
        label: "command.intents",
        icon: ListTree,
        enabled: hasProject,
        run: run(() => {
          setLeftTab("intents");
        }),
      },
      {
        id: "files",
        group: "command.group.navigate",
        label: "command.files",
        icon: FileCode2,
        enabled: hasProject,
        run: run(() => {
          setLeftTab("files");
        }),
      },
      {
        id: "review",
        group: "command.group.review",
        label: "command.review",
        icon: GitPullRequest,
        enabled: reviewing,
        run: run(() => setReviewOpen(true)),
      },
      {
        id: "approve",
        group: "command.group.review",
        label: "command.approve",
        icon: ShieldCheck,
        shortcut: "Ctrl/Cmd Shift Enter",
        enabled: proposal?.status === "in_review",
        run: run(() => void approveProposal()),
      },
      {
        id: "reject",
        group: "command.group.review",
        label: "command.reject",
        icon: XCircle,
        enabled: reviewing,
        run: run(() => void rejectProposal()),
      },
      {
        id: "expand-all",
        group: "command.group.view",
        label: "command.expandAll",
        icon: Layers3,
        enabled: hasProject && l0Ids.length > 0,
        run: run(() => expandAllL0(l0Ids)),
      },
      {
        id: "collapse-all",
        group: "command.group.view",
        label: "command.collapseAll",
        icon: PanelLeft,
        enabled: hasProject,
        run: run(() => collapseAllL0()),
      },
      {
        id: "toggle-intents",
        group: "command.group.view",
        label: "command.toggleIntents",
        icon: PanelLeft,
        shortcut: "Ctrl/Cmd Alt I",
        enabled: hasProject,
        run: run(() => toggleIntents()),
      },
      {
        id: "settings",
        group: "command.group.preferences",
        label: "command.settings",
        icon: Settings,
        shortcut: "Ctrl/Cmd ,",
        enabled: true,
        run: run(() => openSettings("general")),
      },
      {
        id: "language",
        group: "command.group.preferences",
        label: "command.toggleLanguage",
        icon: ArrowLeftRight,
        shortcut: language === "en" ? "中文" : "English",
        enabled: true,
        run: run(() => {
          void saveSettings({ language: language === "en" ? "zh" : "en" });
        }),
      },
    ];
  }, [
    approveProposal,
    closeProject,
    collapseAllL0,
    createProject,
    expandAllL0,
    hasProject,
    l0Ids,
    language,
    openProject,
    openSettings,
    proposal?.status,
    refresh,
    rejectProposal,
    reviewing,
    saveSettings,
    scan,
    setLeftTab,
    setOpen,
    setReviewOpen,
    toggleIntents,
  ]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return commands.filter((command) => {
      if (!command.enabled) return false;
      if (!needle) return true;
      return t(command.label).toLowerCase().includes(needle);
    });
  }, [commands, query, t]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
      return;
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!useJin.getState().commandOpen);
        return;
      }
      if (!useJin.getState().commandOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) =>
          filtered.length === 0 ? 0 : (index + 1) % filtered.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) =>
          filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        filtered[active]?.run();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, filtered, setOpen]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  let lastGroup: MessageKey | null = null;

  return (
    <div
      className="overlay z-[70]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        className="modal mt-[12vh] w-full max-w-[560px] self-start"
        role="dialog"
        aria-modal="true"
        aria-label={t("command.title")}
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
          <Command size={15} className="text-[var(--accent)]" />
          <input
            ref={inputRef}
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-[var(--faint)]"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("command.placeholder")}
            aria-label={t("command.title")}
          />
          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[9px] text-[var(--faint)]">
            Esc
          </span>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-[var(--muted)]">
              {t("command.noResults")}
            </div>
          ) : (
            filtered.map((command, index) => {
              const Icon = command.icon;
              const showGroup = command.group !== lastGroup;
              lastGroup = command.group;
              return (
                <div key={command.id}>
                  {showGroup ? (
                    <div className="px-2 pt-3 pb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--faint)]">
                      {t(command.group)}
                    </div>
                  ) : null}
                  <button
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors ${
                      index === active
                        ? "bg-[var(--accent-soft)] text-[var(--text)]"
                        : "text-[var(--muted)] hover:bg-[var(--panel-soft)]"
                    }`}
                    onMouseEnter={() => setActive(index)}
                    onClick={command.run}
                  >
                    <Icon size={14} className="shrink-0 text-[var(--accent)]" />
                    <span className="flex-1">{t(command.label)}</span>
                    {command.shortcut ? (
                      <span className="text-[9px] text-[var(--faint)]">
                        {command.shortcut}
                      </span>
                    ) : (
                      <ChevronRight size={12} className="text-[var(--faint)]" />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
