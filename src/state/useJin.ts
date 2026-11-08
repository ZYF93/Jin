import { create } from "zustand";
import type {
  AppState,
  AppSettings,
  ChatStream,
  FileContent,
  FileNode,
  GitActionResult,
  GitBranchList,
  GitCommit,
  GitCommitDetail,
  GitStatus,
  LspInstallResult,
  MarketplaceSearchResult,
  MenuAction,
  ProposalView,
  SettingsPatch,
  ToolsInfo,
  UpdateState,
  VersionReplay,
} from "../../shared/ipc";
import { setLanguage, t } from "../lib/i18n";
import { errorMessage, isReviewing } from "../lib/utils";

export type LeftTab = "intents" | "files" | "git";
export type SettingsTab = "general" | "provider" | "team" | "tools";
export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export type ExpandedL0 = Record<string, true>;

interface JinStore {
  app: AppState | null;
  ready: boolean;
  startupError: string | null;
  busy: string | null;
  toasts: Toast[];
  intentsCollapsed: boolean;
  /** L0 modules whose L1 units are currently revealed. */
  expandedL0: ExpandedL0;
  leftTab: LeftTab;
  selectedNodeId: string | null;
  /** Direct-relation focus mode on the architecture canvas. */
  focusNodeId: string | null;
  /** Render the bundled demo architecture instead of a project. */
  demoGraph: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  commandOpen: boolean;
  reviewOpen: boolean;
  selectedVersionId: string | null;
  versionReplay: VersionReplay | null;
  versionReplayLoading: boolean;
  versionReplayError: string | null;
  fileTree: FileNode | null;
  fileTreeLoading: boolean;
  selectedFile: string | null;
  selectedLine: number | null;
  fileContent: FileContent | null;
  fileLoading: boolean;
  fileError: string | null;
  /** Transient assistant text from the current planning/implementation turn. */
  stream: ChatStream | null;
  update: UpdateState | null;
  gitStatus: GitStatus | null;
  gitBranches: GitBranchList | null;
  gitCommits: GitCommit[];
  gitDetail: GitCommitDetail | null;
  gitDetailHash: string | null;
  gitLoading: boolean;
  gitBranchesLoading: boolean;
  gitDetailLoading: boolean;
  gitAction: string | null;
  gitError: string | null;

  initialize: () => Promise<void>;
  notify: (kind: ToastKind, message: string) => void;
  dismissToast: (id: number) => void;
  openProject: (path?: string) => Promise<void>;
  createProject: () => Promise<void>;
  closeProject: () => Promise<void>;
  refresh: () => Promise<void>;
  scan: () => Promise<void>;
  amendArchitecture: (versionId: string) => Promise<void>;
  mergeIntent: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  approveProposal: (note?: string) => Promise<void>;
  rejectProposal: (note?: string) => Promise<void>;
  retryImplementation: (versionId?: string) => Promise<void>;
  cancelAgent: () => Promise<void>;
  saveSettings: (patch: SettingsPatch) => Promise<boolean>;
  refreshTools: () => Promise<ToolsInfo | null>;
  searchExtensions: (query: string, limit?: number) => Promise<MarketplaceSearchResult | null>;
  installLspExtension: (id: string) => Promise<LspInstallResult | null>;
  uninstallLspExtension: (id: string) => Promise<LspInstallResult | null>;
  installMergeDriver: () => Promise<{ ok: boolean; message: string } | null>;
  getMergeInstructions: () => Promise<string | null>;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  loadFileTree: () => Promise<void>;
  openFile: (path: string, line?: number) => Promise<void>;
  loadGit: () => Promise<void>;
  loadGitBranches: () => Promise<void>;
  loadGitHistory: (limit?: number) => Promise<void>;
  selectGitCommit: (hash: string | null) => Promise<void>;
  checkoutGit: (
    name: string,
    create?: boolean,
    dirtyAction?: "carry" | "stash",
  ) => Promise<boolean>;
  stageGit: (paths?: string[]) => Promise<boolean>;
  unstageGit: (paths?: string[]) => Promise<boolean>;
  commitGit: (message: string) => Promise<boolean>;
  pushGit: () => Promise<boolean>;
  pullGit: () => Promise<boolean>;
  fetchGit: () => Promise<boolean>;
  setIntentsCollapsed: (collapsed: boolean) => void;
  toggleIntents: () => void;
  setExpandedL0: (id: string, expanded: boolean) => void;
  toggleExpandedL0: (id: string) => void;
  expandAllL0: (ids: string[]) => void;
  collapseAllL0: () => void;
  setLeftTab: (tab: LeftTab) => void;
  setSelectedNode: (id: string | null) => void;
  setFocusNode: (id: string | null) => void;
  setDemoGraph: (enabled: boolean) => void;
  openSettings: (tab?: SettingsTab) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setCommandOpen: (open: boolean) => void;
  setReviewOpen: (open: boolean) => void;
  selectVersion: (versionId: string | null) => Promise<void>;
  handleMenu: (action: MenuAction) => void;
}

let started: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let toastSequence = 0;

export const useJin = create<JinStore>((set, get) => {
  const notify = (kind: ToastKind, message: string): void => {
    const id = ++toastSequence;
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }));
    window.setTimeout(() => get().dismissToast(id), kind === "error" ? 7200 : 4200);
  };

  const execute = async (
    label: string,
    action: () => Promise<AppState>,
  ): Promise<AppState | undefined> => {
    set({ busy: label });
    try {
      const app = await action();
      set({ app });
      return app;
    } catch (error) {
      notify("error", errorMessage(error));
      return undefined;
    } finally {
      set({ busy: null });
    }
  };

  const runGit = async (
    label: string,
    action: () => Promise<GitActionResult>,
  ): Promise<boolean> => {
    set({ gitAction: label, gitError: null });
    try {
      const result = await action();
      set({
        gitStatus: result.status,
        gitAction: null,
        gitDetail: null,
        gitDetailHash: null,
      });
      notify("success", t("git.actionDone", { action: label }));
      await get().loadGitHistory();
      return true;
    } catch (error) {
      const message = errorMessage(error);
      set({ gitAction: null, gitError: message });
      notify("error", `${t("git.error")}: ${message}`);
      return false;
    }
  };

  const acceptState = (next: AppState): void => {
    setLanguage(next.settings.language);
    const previous = get().app;
    const previousProject = previous?.project?.root ?? null;
    const nextProject = next.project?.root ?? null;
    const projectChanged = previousProject !== nextProject;
    const previousProposal = previous?.proposal;
    const nextProposal = next.proposal;
    const newProposal =
      nextProposal && isReviewing(nextProposal) && nextProposal.id !== previousProposal?.id;
    const reviewEnded =
      Boolean(previousProposal) && isReviewing(previousProposal) && !isReviewing(nextProposal);
    const latestVersion = Object.values(next.snapshot?.versions ?? {})
      .filter((version) => version.ordinal !== null)
      .sort((left, right) => (right.ordinal ?? 0) - (left.ordinal ?? 0))[0];

    const patch: Partial<JinStore> = { app: next };
    if (newProposal) {
      patch.expandedL0 = {};
      patch.selectedVersionId = null;
      patch.versionReplay = null;
      patch.versionReplayError = null;
      patch.selectedNodeId = null;
      patch.focusNodeId = null;
    }
    if (newProposal || reviewEnded) patch.reviewOpen = false;
    if (projectChanged) {
      patch.fileTree = null;
      patch.fileTreeLoading = false;
      patch.selectedFile = null;
      patch.selectedLine = null;
      patch.fileContent = null;
      patch.fileError = null;
      patch.fileLoading = false;
      patch.selectedNodeId = null;
      patch.focusNodeId = null;
      patch.demoGraph = false;
      patch.expandedL0 = {};
      patch.leftTab = "intents";
      patch.reviewOpen = false;
      patch.selectedVersionId = null;
      patch.versionReplay = null;
      patch.versionReplayLoading = false;
      patch.versionReplayError = null;
      patch.gitStatus = null;
      patch.gitBranches = null;
      patch.gitCommits = [];
      patch.gitDetail = null;
      patch.gitDetailHash = null;
      patch.gitBranchesLoading = false;
      patch.gitError = null;
    }
    set(patch);

    // The canvas is a diff viewer, not a live-snapshot viewer. When a project
    // opens or a review resolves, select the newest version and load its diff.
    const shouldSelectLatest =
      latestVersion &&
      !newProposal &&
      !isReviewing(next.proposal) &&
      (projectChanged || reviewEnded) &&
      get().selectedVersionId === null;
    if (shouldSelectLatest) {
      void get().selectVersion(latestVersion.id);
    }

    if (next.project && get().leftTab === "files" && !get().fileTree) {
      void get().loadFileTree();
    }
  };

  const handleAgentEvent = (state: AppState): void => {
    acceptState(state);
  };

  return {
    app: null,
    ready: false,
    startupError: null,
    busy: null,
    toasts: [],
    intentsCollapsed: false,
    expandedL0: {},
    leftTab: "intents",
    selectedNodeId: null,
    focusNodeId: null,
    demoGraph: false,
    settingsOpen: false,
    settingsTab: "general",
    commandOpen: false,
    reviewOpen: false,
    selectedVersionId: null,
    versionReplay: null,
    versionReplayLoading: false,
    versionReplayError: null,
    fileTree: null,
    fileTreeLoading: false,
    selectedFile: null,
    selectedLine: null,
    fileContent: null,
    fileLoading: false,
    fileError: null,
    stream: null,
    update: null,
    gitStatus: null,
    gitBranches: null,
    gitCommits: [],
    gitDetail: null,
    gitDetailHash: null,
    gitLoading: false,
    gitBranchesLoading: false,
    gitDetailLoading: false,
    gitAction: null,
    gitError: null,

    initialize: async () => {
      if (started) return started;
      started = (async () => {
        try {
          if (!window.jin) {
            throw new Error(t("error.preload"));
          }
          unsubscribe?.();
          unsubscribe = window.jin.onEvent((event) => {
            if (event.type === "state") {
              acceptState(event.state);
            } else if (event.type === "agent") {
              handleAgentEvent(event.state);
            } else if (event.type === "stream") {
              set({ stream: event.stream });
            } else if (event.type === "update") {
              set({ update: event.update });
            } else if (event.type === "menu") {
              get().handleMenu(event.action);
            } else if (event.type === "error") {
              get().notify("error", event.message);
            }
          });
          const app = await window.jin.getState();
          acceptState(app);
          set({ ready: true, startupError: null });
          if (get().leftTab === "git") void get().loadGit();
          void window.jin
            .getUpdateState()
            .then((update) => set({ update }))
            .catch(() => undefined);
        } catch (error) {
          set({ ready: true, startupError: errorMessage(error) });
        }
      })();
      return started;
    },

    notify,
    dismissToast: (id) => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    },

    openProject: async (path) => {
      await execute(t("busy.openingProject"), () => window.jin.openProject(path));
      set({ reviewOpen: false, demoGraph: false });
    },

    createProject: async () => {
      await execute(t("busy.creatingProject"), () => window.jin.createProject());
      set({ reviewOpen: false, demoGraph: false });
    },

    closeProject: async () => {
      const app = await execute(t("busy.closingProject"), () => window.jin.closeProject());
      if (app) {
        set({
          fileTree: null,
          selectedFile: null,
          selectedLine: null,
          fileContent: null,
          fileError: null,
          selectedNodeId: null,
          reviewOpen: false,
          selectedVersionId: null,
          versionReplay: null,
          versionReplayLoading: false,
          versionReplayError: null,
          expandedL0: {},
          leftTab: "intents",
          gitStatus: null,
          gitBranches: null,
          gitCommits: [],
          gitDetail: null,
          gitDetailHash: null,
          gitBranchesLoading: false,
          gitError: null,
        });
      }
    },

    refresh: async () => {
      await execute(t("busy.refreshing"), () => window.jin.refresh());
    },

    scan: async () => {
      await execute(t("busy.scanning"), () => window.jin.scan());
    },

    amendArchitecture: async (versionId) => {
      const app = await execute(t("busy.amending"), () => window.jin.amendArchitecture(versionId));
      if (app?.proposal) {
        notify("success", t("toast.archAmendmentReady"));
      } else if (app) {
        notify("info", t("toast.noDrift"));
      }
    },

    mergeIntent: async () => {
      const app = await execute(t("busy.merging"), () => window.jin.mergeIntent());
      if (app?.proposal) {
        notify("success", t("toast.mergeIntentReady"));
      }
    },

    sendMessage: async (text) => {
      const request = text.trim();
      if (!request || get().busy) return;
      await execute(t("busy.thinking"), () => window.jin.sendMessage(request));
    },

    approveProposal: async (note) => {
      const proposal = get().app?.proposal;
      if (!proposal) {
        notify("info", t("toast.noProposalApprove"));
        return;
      }
      if (proposal.status !== "in_review") {
        notify("error", t("toast.notApprovable"));
        return;
      }
      const app = await execute(t("busy.approving"), () =>
        window.jin.approveProposal(proposal.id, note),
      );
      if (app) {
        set({ reviewOpen: false });
        notify(
          "success",
          proposal.architectureOnly
            ? t("toast.approvedArchitectureOnly")
            : t("toast.approvedImplementationStarted"),
        );
      }
    },

    rejectProposal: async (note) => {
      const proposal = get().app?.proposal;
      if (!proposal) {
        notify("info", t("toast.noProposalReject"));
        return;
      }
      if (!isReviewing(proposal)) {
        notify("error", t("toast.notRejectable"));
        return;
      }
      const app = await execute(t("busy.rejecting"), () =>
        window.jin.rejectProposal(proposal.id, note),
      );
      if (app) {
        set({ reviewOpen: false });
        notify("info", t("toast.rejected"));
      }
    },

    retryImplementation: async (versionId) => {
      await execute(t("busy.startingImplementation"), () =>
        window.jin.retryImplementation(versionId),
      );
    },

    cancelAgent: async () => {
      try {
        await window.jin.cancelAgent();
        notify("info", t("toast.cancellationRequested"));
      } catch (error) {
        notify("error", errorMessage(error));
      }
    },

    saveSettings: async (patch) => {
      try {
        const settings = await window.jin.saveSettings(patch);
        setLanguage(settings.language);
        set((state) => (state.app ? { app: { ...state.app, settings } } : { app: state.app }));
        notify("success", t("toast.settingsSaved"));
        return true;
      } catch (error) {
        notify("error", errorMessage(error));
        return false;
      }
    },

    refreshTools: async () => {
      try {
        const tools = await window.jin.refreshTools();
        set((state) => (state.app ? { app: { ...state.app, tools } } : { app: state.app }));
        return tools;
      } catch (error) {
        notify("error", errorMessage(error));
        return null;
      }
    },

    searchExtensions: async (query, limit) => {
      try {
        return await window.jin.searchExtensions(query, limit);
      } catch (error) {
        notify("error", errorMessage(error));
        return null;
      }
    },

    installLspExtension: async (id) => {
      try {
        const result = await window.jin.installLspExtension(id);
        set((state) =>
          state.app && result.lsp.length > 0
            ? { app: { ...state.app, lsp: result.lsp } }
            : { app: state.app },
        );
        notify(result.ok ? "success" : "error", result.message);
        return result;
      } catch (error) {
        notify("error", errorMessage(error));
        return null;
      }
    },

    uninstallLspExtension: async (id) => {
      try {
        const result = await window.jin.uninstallLspExtension(id);
        set((state) =>
          state.app && result.lsp.length > 0
            ? { app: { ...state.app, lsp: result.lsp } }
            : { app: state.app },
        );
        notify(result.ok ? "success" : "error", result.message);
        return result;
      } catch (error) {
        notify("error", errorMessage(error));
        return null;
      }
    },

    installMergeDriver: async () => {
      try {
        const result = await window.jin.installMergeDriver();
        notify(result.ok ? "success" : "error", result.message);
        return result;
      } catch (error) {
        notify("error", errorMessage(error));
        return null;
      }
    },

    getMergeInstructions: async () => {
      try {
        return await window.jin.mergeInstructions();
      } catch (error) {
        notify("error", errorMessage(error));
        return null;
      }
    },

    checkForUpdates: async () => {
      try {
        set({ update: await window.jin.checkForUpdates() });
      } catch (error) {
        notify("error", errorMessage(error));
      }
    },

    downloadUpdate: async () => {
      try {
        set({ update: await window.jin.downloadUpdate() });
      } catch (error) {
        notify("error", errorMessage(error));
      }
    },

    installUpdate: async () => {
      try {
        await window.jin.installUpdate();
      } catch (error) {
        notify("error", errorMessage(error));
      }
    },

    loadFileTree: async () => {
      if (!get().app?.project) {
        set({ fileTree: null, fileTreeLoading: false });
        return;
      }
      set({ fileTreeLoading: true });
      try {
        const fileTree = await window.jin.getFileTree();
        if (get().app?.project) set({ fileTree, fileTreeLoading: false });
      } catch (error) {
        set({ fileTreeLoading: false });
        notify("error", errorMessage(error));
      }
    },

    openFile: async (path, line) => {
      set({
        selectedFile: path,
        selectedLine: Number.isInteger(line) && line && line > 0 ? line : null,
        fileLoading: true,
        fileError: null,
        fileContent: null,
      });
      try {
        const fileContent = await window.jin.readFile(path);
        if (get().selectedFile === path) {
          set({ fileContent, fileLoading: false });
        }
      } catch (error) {
        if (get().selectedFile === path) {
          set({ fileLoading: false, fileError: errorMessage(error) });
        }
      }
    },

    loadGit: async () => {
      if (!get().app?.project) {
        set({
          gitStatus: null,
          gitBranches: null,
          gitCommits: [],
          gitDetail: null,
          gitDetailHash: null,
          gitLoading: false,
          gitBranchesLoading: false,
        });
        return;
      }
      set({ gitLoading: true, gitError: null });
      try {
        const [gitStatus, gitCommits] = await Promise.all([
          window.jin.gitStatus(),
          window.jin.gitLog(30),
        ]);
        if (get().app?.project) {
          set({ gitStatus, gitCommits, gitLoading: false });
        }
      } catch (error) {
        set({ gitLoading: false, gitError: errorMessage(error) });
      }
    },

    loadGitBranches: async () => {
      if (!get().app?.project) {
        set({ gitBranches: null, gitBranchesLoading: false });
        return;
      }
      set({ gitBranchesLoading: true });
      try {
        const gitBranches = await window.jin.gitBranches();
        if (get().app?.project) {
          set({ gitBranches, gitBranchesLoading: false });
        }
      } catch (error) {
        set({
          gitBranchesLoading: false,
          gitError: errorMessage(error),
        });
      }
    },

    loadGitHistory: async (limit = 30) => {
      if (!get().app?.project) return;
      try {
        const gitCommits = await window.jin.gitLog(limit);
        set({ gitCommits });
      } catch (error) {
        set({ gitError: errorMessage(error) });
      }
    },

    selectGitCommit: async (hash) => {
      if (!hash) {
        set({ gitDetail: null, gitDetailHash: null, gitDetailLoading: false });
        return;
      }
      set({ gitDetailHash: hash, gitDetailLoading: true, gitError: null });
      try {
        const detail = await window.jin.gitShow(hash);
        if (get().gitDetailHash === hash) {
          set({ gitDetail: detail, gitDetailLoading: false });
        }
      } catch (error) {
        if (get().gitDetailHash === hash) {
          set({ gitDetailLoading: false, gitError: errorMessage(error) });
        }
      }
    },

    checkoutGit: async (name, create = false, dirtyAction) => {
      const ok = await runGit(t("git.switchBranch"), () =>
        window.jin.gitCheckout(name, create, dirtyAction),
      );
      if (ok) await get().loadGitBranches();
      return ok;
    },

    stageGit: (paths) => runGit(t("git.stage"), () => window.jin.gitStage(paths)),

    unstageGit: (paths) => runGit(t("git.unstage"), () => window.jin.gitUnstage(paths)),

    commitGit: (message) => runGit(t("git.commit"), () => window.jin.gitCommit(message)),

    pushGit: () => runGit(t("git.push"), () => window.jin.gitPush()),

    pullGit: () => runGit(t("git.pull"), () => window.jin.gitPull()),

    fetchGit: () => runGit(t("git.fetch"), () => window.jin.gitFetch()),

    setIntentsCollapsed: (collapsed) => set({ intentsCollapsed: collapsed }),

    toggleIntents: () => set((state) => ({ intentsCollapsed: !state.intentsCollapsed })),

    setExpandedL0: (id, expanded) =>
      set((state) => {
        if (Boolean(state.expandedL0[id]) === expanded) return state;
        const next = { ...state.expandedL0 };
        if (expanded) next[id] = true;
        else delete next[id];
        return { expandedL0: next };
      }),

    toggleExpandedL0: (id) =>
      set((state) => {
        const next = { ...state.expandedL0 };
        if (next[id]) delete next[id];
        else next[id] = true;
        return { expandedL0: next };
      }),

    expandAllL0: (ids) =>
      set({
        expandedL0: Object.fromEntries(ids.map((id) => [id, true as const])),
      }),

    collapseAllL0: () => set({ expandedL0: {} }),

    setLeftTab: (tab) => {
      set({ leftTab: tab });
      if (tab === "files" && !get().fileTree && !get().fileTreeLoading) {
        void get().loadFileTree();
      }
      if (tab === "git") void get().loadGit();
    },

    setSelectedNode: (id) => set({ selectedNodeId: id }),

    setFocusNode: (id) => set({ focusNodeId: id }),

    setDemoGraph: (enabled) =>
      set({
        demoGraph: enabled,
        selectedNodeId: null,
        focusNodeId: null,
        expandedL0: enabled
          ? {
              "demo:module:catalog": true,
              "demo:module:checkout": true,
              "demo:module:reviews": true,
            }
          : {},
        selectedVersionId: enabled ? null : get().selectedVersionId,
        versionReplay: enabled ? null : get().versionReplay,
      }),

    openSettings: (tab = "general") => set({ settingsOpen: true, settingsTab: tab }),

    setSettingsOpen: (open) => set({ settingsOpen: open }),

    setSettingsTab: (tab) => set({ settingsTab: tab }),

    setCommandOpen: (open) => set({ commandOpen: open }),

    setReviewOpen: (open) => set({ reviewOpen: open }),

    selectVersion: async (versionId) => {
      if (!versionId) {
        set({
          selectedVersionId: null,
          versionReplay: null,
          versionReplayLoading: false,
          versionReplayError: null,
          selectedNodeId: null,
          focusNodeId: null,
          expandedL0: {},
        });
        return;
      }
      if (get().selectedVersionId === versionId && get().versionReplay?.versionId === versionId) {
        return;
      }
      set({
        selectedVersionId: versionId,
        versionReplay: null,
        versionReplayLoading: true,
        versionReplayError: null,
        selectedNodeId: null,
        focusNodeId: null,
        expandedL0: {},
      });
      try {
        const replay = await window.jin.replayVersion(versionId);
        if (get().selectedVersionId === versionId) {
          set({ versionReplay: replay, versionReplayLoading: false });
        }
      } catch (error) {
        if (get().selectedVersionId === versionId) {
          set({
            versionReplayLoading: false,
            versionReplayError: errorMessage(error),
          });
          notify("error", errorMessage(error));
        }
      }
    },

    handleMenu: (action) => {
      switch (action) {
        case "settings":
          get().openSettings("general");
          break;
        case "scan":
          void get().scan();
          break;
        case "toggle-intents":
          get().toggleIntents();
          break;
        case "toggle-chat":
          notify("info", t("toast.chatStaysVisible"));
          break;
        case "command-palette":
          set({ commandOpen: true });
          break;
        case "approve": {
          const proposal = get().app?.proposal;
          if (proposal && proposal.status === "in_review") {
            void get().approveProposal();
          } else {
            notify("info", t("toast.noProposalToApprove"));
          }
          break;
        }
        case "reject": {
          const proposal = get().app?.proposal;
          if (proposal && isReviewing(proposal)) {
            void get().rejectProposal();
          } else {
            notify("info", t("toast.noProposalToReject"));
          }
          break;
        }
        case "open-project":
          void get().openProject();
          break;
        case "new-project":
          void get().createProject();
          break;
        case "about":
          notify("info", t("toast.about"));
          break;
        default:
          break;
      }
    },
  };
});

export function selectProposal(state: JinStore): ProposalView | null {
  return state.app?.proposal ?? null;
}

export function selectSettings(state: JinStore): AppSettings | null {
  return state.app?.settings ?? null;
}
