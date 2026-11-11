import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type AppSettings,
  type AppState,
  type FileContent,
  type FileNode,
  type GitActionResult,
  type GitBranchList,
  type GitCommit,
  type GitCommitDetail,
  type GitStatus,
  type JinBridge,
  type JinEvent,
  type LspInstallResult,
  type MarketplaceSearchResult,
  type McpCallResult,
  type ProviderModelCatalog,
  type ProviderModelRequest,
  type ReuseCandidate,
  type SettingsPatch,
  type ToolsInfo,
  type UpdateState,
  type VersionReplay,
} from "../shared/ipc";

const bridge: JinBridge = {
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.getState) as Promise<AppState>,
  openProject: (path?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openProject, path) as Promise<AppState>,
  createProject: () => ipcRenderer.invoke(IPC_CHANNELS.createProject) as Promise<AppState>,
  closeProject: () => ipcRenderer.invoke(IPC_CHANNELS.closeProject) as Promise<AppState>,
  chooseProjectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseProjectDirectory) as Promise<string | null>,
  refresh: () => ipcRenderer.invoke(IPC_CHANNELS.refresh) as Promise<AppState>,
  scan: () => ipcRenderer.invoke(IPC_CHANNELS.scan) as Promise<AppState>,
  amendArchitecture: (versionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.amendArchitecture, versionId) as Promise<AppState>,
  mergeIntent: () => ipcRenderer.invoke(IPC_CHANNELS.mergeIntent) as Promise<AppState>,
  sendMessage: (text: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.sendMessage, text) as Promise<AppState>,
  approveProposal: (id: string, note?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.approveProposal, id, note) as Promise<AppState>,
  rejectProposal: (id: string, note?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.rejectProposal, id, note) as Promise<AppState>,
  retryImplementation: (versionId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.retryImplementation, versionId) as Promise<AppState>,
  replayVersion: (versionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.replayVersion, versionId) as Promise<VersionReplay>,
  cancelAgent: () => ipcRenderer.invoke(IPC_CHANNELS.cancelAgent) as Promise<void>,
  getFileTree: () => ipcRenderer.invoke(IPC_CHANNELS.getFileTree) as Promise<FileNode>,
  readFile: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.readFile, path) as Promise<FileContent>,
  openInExternalEditor: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openInExternalEditor, path) as Promise<void>,
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings) as Promise<AppSettings>,
  saveSettings: (patch: SettingsPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveSettings, patch) as Promise<AppSettings>,
  getLlmLogPath: () => ipcRenderer.invoke(IPC_CHANNELS.getLlmLogPath) as Promise<string>,
  openLlmLogFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openLlmLogFolder) as Promise<void>,
  getTools: () => ipcRenderer.invoke(IPC_CHANNELS.getTools) as Promise<ToolsInfo>,
  refreshTools: () => ipcRenderer.invoke(IPC_CHANNELS.refreshTools) as Promise<ToolsInfo>,
  searchExtensions: (query: string, limit?: number) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.searchExtensions,
      query,
      limit,
    ) as Promise<MarketplaceSearchResult>,
  installLspExtension: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.installLspExtension, id) as Promise<LspInstallResult>,
  uninstallLspExtension: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.uninstallLspExtension, id) as Promise<LspInstallResult>,
  searchCode: (query: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.searchCode, query, limit) as Promise<ReuseCandidate[]>,
  listModels: (request: ProviderModelRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.listModels, request) as Promise<ProviderModelCatalog>,
  mcpCall: (server: string, tool: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpCall, server, tool, args) as Promise<McpCallResult>,
  gitStatus: () => ipcRenderer.invoke(IPC_CHANNELS.gitStatus) as Promise<GitStatus>,
  gitBranches: () => ipcRenderer.invoke(IPC_CHANNELS.gitBranches) as Promise<GitBranchList>,
  gitCheckout: (name: string, create?: boolean, dirtyAction?: "carry" | "stash") =>
    ipcRenderer.invoke(
      IPC_CHANNELS.gitCheckout,
      name,
      create,
      dirtyAction,
    ) as Promise<GitActionResult>,
  gitLog: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.gitLog, limit) as Promise<GitCommit[]>,
  gitShow: (hash: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.gitShow, hash) as Promise<GitCommitDetail>,
  gitStage: (paths?: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.gitStage, paths) as Promise<GitActionResult>,
  gitUnstage: (paths?: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.gitUnstage, paths) as Promise<GitActionResult>,
  gitCommit: (message: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.gitCommit, message) as Promise<GitActionResult>,
  gitPush: () => ipcRenderer.invoke(IPC_CHANNELS.gitPush) as Promise<GitActionResult>,
  gitPull: () => ipcRenderer.invoke(IPC_CHANNELS.gitPull) as Promise<GitActionResult>,
  gitFetch: () => ipcRenderer.invoke(IPC_CHANNELS.gitFetch) as Promise<GitActionResult>,
  installMergeDriver: () =>
    ipcRenderer.invoke(IPC_CHANNELS.installMergeDriver) as Promise<{
      ok: boolean;
      message: string;
    }>,
  mergeInstructions: () => ipcRenderer.invoke(IPC_CHANNELS.mergeInstructions) as Promise<string>,
  getUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.getUpdateState) as Promise<UpdateState>,
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates) as Promise<UpdateState>,
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadUpdate) as Promise<UpdateState>,
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.installUpdate) as Promise<void>,
  onEvent: (listener: (event: JinEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: JinEvent) => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.event, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.event, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("jin", bridge);
