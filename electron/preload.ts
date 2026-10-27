import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type AppSettings,
  type AppState,
  type FileContent,
  type FileNode,
  type JinBridge,
  type JinEvent,
  type SettingsPatch,
  type ToolsInfo,
} from "../shared/ipc";

const bridge: JinBridge = {
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.getState) as Promise<AppState>,
  openProject: (path?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openProject, path) as Promise<AppState>,
  createProject: () =>
    ipcRenderer.invoke(IPC_CHANNELS.createProject) as Promise<AppState>,
  closeProject: () =>
    ipcRenderer.invoke(IPC_CHANNELS.closeProject) as Promise<AppState>,
  chooseProjectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseProjectDirectory) as Promise<string | null>,
  refresh: () => ipcRenderer.invoke(IPC_CHANNELS.refresh) as Promise<AppState>,
  scan: () => ipcRenderer.invoke(IPC_CHANNELS.scan) as Promise<AppState>,
  sendMessage: (text: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.sendMessage, text) as Promise<AppState>,
  approveProposal: (id: string, note?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.approveProposal, id, note) as Promise<AppState>,
  rejectProposal: (id: string, note?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.rejectProposal, id, note) as Promise<AppState>,
  retryImplementation: (versionId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.retryImplementation, versionId) as Promise<AppState>,
  cancelAgent: () =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelAgent) as Promise<void>,
  getFileTree: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getFileTree) as Promise<FileNode>,
  readFile: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.readFile, path) as Promise<FileContent>,
  openInExternalEditor: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openInExternalEditor, path) as Promise<void>,
  getSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getSettings) as Promise<AppSettings>,
  saveSettings: (patch: SettingsPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveSettings, patch) as Promise<AppSettings>,
  getTools: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getTools) as Promise<ToolsInfo>,
  refreshTools: () =>
    ipcRenderer.invoke(IPC_CHANNELS.refreshTools) as Promise<ToolsInfo>,
  installMergeDriver: () =>
    ipcRenderer.invoke(IPC_CHANNELS.installMergeDriver) as Promise<{
      ok: boolean;
      message: string;
    }>,
  mergeInstructions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.mergeInstructions) as Promise<string>,
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
