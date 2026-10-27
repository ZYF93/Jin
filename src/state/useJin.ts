import { create } from "zustand";
import type {
  AppState,
  AppSettings,
  FileContent,
  FileNode,
  MenuAction,
  ProposalView,
  SettingsPatch,
  ToolsInfo,
} from "../../shared/ipc";
import { errorMessage, isReviewing } from "../lib/utils";

export type LeftTab = "intents" | "files";
export type SettingsTab = "general" | "provider" | "team" | "tools";
export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface JinStore {
  app: AppState | null;
  ready: boolean;
  startupError: string | null;
  busy: string | null;
  toasts: Toast[];
  intentsCollapsed: boolean;
  expanded: boolean;
  leftTab: LeftTab;
  selectedNodeId: string | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  reviewOpen: boolean;
  fileTree: FileNode | null;
  fileTreeLoading: boolean;
  selectedFile: string | null;
  fileContent: FileContent | null;
  fileLoading: boolean;
  fileError: string | null;

  initialize: () => Promise<void>;
  notify: (kind: ToastKind, message: string) => void;
  dismissToast: (id: number) => void;
  openProject: (path?: string) => Promise<void>;
  createProject: () => Promise<void>;
  closeProject: () => Promise<void>;
  refresh: () => Promise<void>;
  scan: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  approveProposal: (note?: string) => Promise<void>;
  rejectProposal: (note?: string) => Promise<void>;
  retryImplementation: (versionId?: string) => Promise<void>;
  cancelAgent: () => Promise<void>;
  saveSettings: (patch: SettingsPatch) => Promise<boolean>;
  refreshTools: () => Promise<ToolsInfo | null>;
  installMergeDriver: () => Promise<{ ok: boolean; message: string } | null>;
  getMergeInstructions: () => Promise<string | null>;
  loadFileTree: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  setIntentsCollapsed: (collapsed: boolean) => void;
  toggleIntents: () => void;
  setExpanded: (expanded: boolean) => void;
  setLeftTab: (tab: LeftTab) => void;
  setSelectedNode: (id: string | null) => void;
  openSettings: (tab?: SettingsTab) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setReviewOpen: (open: boolean) => void;
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

  const acceptState = (next: AppState): void => {
    const previous = get().app;
    const previousProject = previous?.project?.root ?? null;
    const nextProject = next.project?.root ?? null;
    const projectChanged = previousProject !== nextProject;
    const previousProposal = previous?.proposal;
    const nextProposal = next.proposal;
    const newProposal =
      nextProposal &&
      isReviewing(nextProposal) &&
      nextProposal.id !== previousProposal?.id;
    const reviewEnded =
      Boolean(previousProposal) &&
      isReviewing(previousProposal) &&
      !isReviewing(nextProposal);

    const patch: Partial<JinStore> = { app: next };
    if (newProposal) patch.expanded = true;
    if (newProposal || reviewEnded) patch.reviewOpen = false;
    if (projectChanged) {
      patch.fileTree = null;
      patch.fileTreeLoading = false;
      patch.selectedFile = null;
      patch.fileContent = null;
      patch.fileError = null;
      patch.fileLoading = false;
      patch.selectedNodeId = null;
      patch.leftTab = "intents";
      patch.reviewOpen = false;
    }
    set(patch);

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
    expanded: false,
    leftTab: "intents",
    selectedNodeId: null,
    settingsOpen: false,
    settingsTab: "general",
    reviewOpen: false,
    fileTree: null,
    fileTreeLoading: false,
    selectedFile: null,
    fileContent: null,
    fileLoading: false,
    fileError: null,

    initialize: async () => {
      if (started) return started;
      started = (async () => {
        try {
          if (!window.jin) {
            throw new Error(
              "The Jin preload bridge is unavailable. Start the app through Electron.",
            );
          }
          unsubscribe?.();
          unsubscribe = window.jin.onEvent((event) => {
            if (event.type === "state") {
              acceptState(event.state);
            } else if (event.type === "agent") {
              handleAgentEvent(event.state);
            } else if (event.type === "menu") {
              get().handleMenu(event.action);
            } else if (event.type === "error") {
              get().notify("error", event.message);
            }
          });
          const app = await window.jin.getState();
          acceptState(app);
          set({ ready: true, startupError: null });
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
      await execute("Opening project…", () => window.jin.openProject(path));
      set({ reviewOpen: false });
    },

    createProject: async () => {
      await execute("Creating project…", () => window.jin.createProject());
      set({ reviewOpen: false });
    },

    closeProject: async () => {
      const app = await execute("Closing project…", () => window.jin.closeProject());
      if (app) {
        set({
          fileTree: null,
          selectedFile: null,
          fileContent: null,
          fileError: null,
          selectedNodeId: null,
          reviewOpen: false,
          leftTab: "intents",
        });
      }
    },

    refresh: async () => {
      await execute("Refreshing architecture…", () => window.jin.refresh());
    },

    scan: async () => {
      await execute("Scanning source…", () => window.jin.scan());
    },

    sendMessage: async (text) => {
      const request = text.trim();
      if (!request || get().busy) return;
      await execute("Thinking…", () => window.jin.sendMessage(request));
    },

    approveProposal: async (note) => {
      const proposal = get().app?.proposal;
      if (!proposal) {
        notify("info", "There is no proposal to approve.");
        return;
      }
      if (proposal.status !== "in_review") {
        notify("error", "This proposal is not approvable. Rescan to create a fresh review.");
        return;
      }
      const app = await execute("Applying approval…", () =>
        window.jin.approveProposal(proposal.id, note),
      );
      if (app) {
        set({ reviewOpen: false });
        notify("success", "Architecture approved. The implementation turn has started.");
      }
    },

    rejectProposal: async (note) => {
      const proposal = get().app?.proposal;
      if (!proposal) {
        notify("info", "There is no proposal to reject.");
        return;
      }
      if (!isReviewing(proposal)) {
        notify("error", "This proposal is no longer rejectable.");
        return;
      }
      const app = await execute("Rejecting proposal…", () =>
        window.jin.rejectProposal(proposal.id, note),
      );
      if (app) {
        set({ reviewOpen: false });
        notify("info", "Proposal rejected. It remains in the audit history.");
      }
    },

    retryImplementation: async (versionId) => {
      await execute("Starting implementation…", () =>
        window.jin.retryImplementation(versionId),
      );
    },

    cancelAgent: async () => {
      try {
        await window.jin.cancelAgent();
        notify("info", "Cancellation requested.");
      } catch (error) {
        notify("error", errorMessage(error));
      }
    },

    saveSettings: async (patch) => {
      try {
        const settings = await window.jin.saveSettings(patch);
        set((state) =>
          state.app ? { app: { ...state.app, settings } } : { app: state.app },
        );
        notify("success", "Settings saved.");
        return true;
      } catch (error) {
        notify("error", errorMessage(error));
        return false;
      }
    },

    refreshTools: async () => {
      try {
        const tools = await window.jin.refreshTools();
        set((state) =>
          state.app ? { app: { ...state.app, tools } } : { app: state.app },
        );
        return tools;
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

    openFile: async (path) => {
      set({
        selectedFile: path,
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

    setIntentsCollapsed: (collapsed) => set({ intentsCollapsed: collapsed }),

    toggleIntents: () => set((state) => ({ intentsCollapsed: !state.intentsCollapsed })),

    setExpanded: (expanded) => set({ expanded }),

    setLeftTab: (tab) => {
      set({ leftTab: tab });
      if (tab === "files" && !get().fileTree && !get().fileTreeLoading) {
        void get().loadFileTree();
      }
    },

    setSelectedNode: (id) => set({ selectedNodeId: id }),

    openSettings: (tab = "general") => set({ settingsOpen: true, settingsTab: tab }),

    setSettingsOpen: (open) => set({ settingsOpen: open }),

    setSettingsTab: (tab) => set({ settingsTab: tab }),

    setReviewOpen: (open) => set({ reviewOpen: open }),

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
          notify("info", "The chat panel stays visible in every layout.");
          break;
        case "approve": {
          const proposal = get().app?.proposal;
          if (proposal && proposal.status === "in_review") {
            void get().approveProposal();
          } else {
            notify("info", "There is no proposal in review to approve.");
          }
          break;
        }
        case "reject": {
          const proposal = get().app?.proposal;
          if (proposal && isReviewing(proposal)) {
            void get().rejectProposal();
          } else {
            notify("info", "There is no proposal in review to reject.");
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
          notify("info", "Jin is an architecture-first coding agent.");
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
