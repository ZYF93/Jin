import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type MessageBoxOptions,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
} from "electron";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MenuAction } from "../shared/ipc";
import {
  IPC_CHANNELS,
  type AppSettings,
  type AppState,
  type FileContent,
  type FileNode,
  type JinEvent,
  type RecentProject,
  type SettingsPatch,
  type ToolsInfo,
} from "../shared/ipc";
import {
  closeAppDatabase,
  listRecentProjects,
  openAppDatabase,
  recordRecentProject,
  type AppDatabase,
} from "./core/db/app-db";
import { initProject } from "./core/project/init";
import { locateProject } from "./core/project/config";
import { ProjectSession } from "./core/session";
import { SettingsStore } from "./core/settings/app-settings";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Opt-in CDP access for development and UI smoke tests. Never enabled by default.
const debugPort = process.env.JIN_DEBUG_PORT;
if (debugPort) {
  app.commandLine.appendSwitch("remote-debugging-port", debugPort);
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

process.env.APP_ROOT = join(__dirname, "..");

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

const BUILTIN_TOOLS = [
  "arch.propose",
  "arch.scan",
  "code.read",
  "code.write",
  "code.search",
  "shell.run",
  "test.run",
  "lsp.symbols",
  "git.status",
  "mcp.call",
  "skill.read",
];

let mainWindow: BrowserWindow | null = null;
let appDatabase: AppDatabase | null = null;
let settingsStore: SettingsStore | null = null;
let activeSession: ProjectSession | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function emptyTools(): ToolsInfo {
  return {
    builtin: BUILTIN_TOOLS,
    skills: [],
    mcpServers: [],
    updatedAt: nowIso(),
  };
}

function recentProjects(): RecentProject[] {
  return appDatabase ? listRecentProjects(appDatabase, 10) : [];
}

function emptySettings(): AppSettings {
  if (settingsStore) return settingsStore.get();
  return {
    theme: "dark",
    glass: "subtle",
    provider: {
      kind: "none",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      hasApiKey: false,
    },
    agent: { autoImplement: true, temperature: 0.2, maxTokens: 8000 },
    identity: { actorId: "user:uninitialized", name: "Jin user", email: "" },
    ui: { reduceMotion: false },
  };
}

function emptyState(): AppState {
  return {
    project: null,
    snapshot: null,
    proposal: null,
    messages: [],
    settings: emptySettings(),
    recentProjects: recentProjects(),
    scan: {
      phase: "idle",
      files: 0,
      symbols: 0,
      nodes: 0,
      edges: 0,
      message: "Open a project to begin.",
      updatedAt: null,
    },
    lsp: [],
    tools: emptyTools(),
    wal: {
      records: 0,
      conflicts: [],
      warnings: [],
      lastRecordId: null,
    },
    agent: { phase: "idle", message: "Ready." },
    fold: null,
  };
}

function sessionState(): AppState {
  return activeSession ? activeSession.getState() : emptyState();
}

function sendEvent(event: JinEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.event, event);
}

function broadcastState(): void {
  sendEvent({ type: "state", state: sessionState() });
}

function requireSession(): ProjectSession {
  if (!activeSession) throw new Error("Open a Jin project first.");
  return activeSession;
}

function requireSettings(): SettingsStore {
  if (!settingsStore) throw new Error("Jin settings are not initialized yet.");
  return settingsStore;
}

function requireDatabase(): AppDatabase {
  if (!appDatabase) throw new Error("Jin's application database is not initialized yet.");
  return appDatabase;
}

function applyNativeTheme(theme: AppSettings["theme"]): void {
  nativeTheme.themeSource = theme;
}

function showMessage(options: MessageBoxOptions) {
  return mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

function showOpenDialog(options: OpenDialogOptions) {
  return mainWindow
    ? dialog.showOpenDialog(mainWindow, options)
    : dialog.showOpenDialog(options);
}

async function pickProjectDirectory(title: string): Promise<string | null> {
  const result = await showOpenDialog({
    title,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Choose folder",
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function confirmInitialize(root: string): Promise<boolean> {
  const result = await showMessage({
    type: "question",
    title: "Initialize Jin",
    message: `Initialize Jin in “${root}”?`,
    detail:
      "Jin creates a .jin/ directory containing the append-only architecture WAL, then scans the source tree to prepare the first import proposal. Approved history is never overwritten.",
    buttons: ["Initialize", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

async function openProjectPath(
  inputPath: string,
  options: { initialize?: boolean } = {},
): Promise<AppState> {
  const selected = resolve(inputPath);
  if (!existsSync(selected)) throw new Error(`The folder does not exist: ${selected}`);
  if (!statSync(selected).isDirectory()) throw new Error(`Not a folder: ${selected}`);

  const located = locateProject(selected);
  const root = located?.root ?? selected;

  if (activeSession?.root === root) {
    await activeSession.refresh();
    broadcastState();
    return sessionState();
  }

  if (!existsSync(join(root, ".jin"))) {
    const allowed = options.initialize === true || (await confirmInitialize(root));
    if (!allowed) return sessionState();
    initProject(root);
  }

  const previous = activeSession;
  const next = new ProjectSession(root, {
    settings: requireSettings(),
    recentProjects,
    emit: (event) => sendEvent(event),
  });

  activeSession = next;
  try {
    await next.initialize();
  } catch (error) {
    next.close();
    activeSession = previous;
    throw error;
  }

  previous?.close();
  recordRecentProject(requireDatabase(), {
    path: next.root,
    name: next.config.project.name,
  });
  rebuildApplicationMenu();
  broadcastState();
  return sessionState();
}

async function openProjectFromDialog(): Promise<AppState> {
  const path = await pickProjectDirectory("Open a Jin project folder");
  if (!path) return sessionState();
  return openProjectPath(path);
}

async function createProjectFromDialog(): Promise<AppState> {
  const path = await pickProjectDirectory("Choose a folder for the new Jin project");
  if (!path) return sessionState();
  if (existsSync(join(path, ".jin"))) {
    return openProjectPath(path);
  }
  initProject(path);
  return openProjectPath(path, { initialize: true });
}

function closeProject(): AppState {
  activeSession?.close();
  activeSession = null;
  rebuildApplicationMenu();
  broadcastState();
  return sessionState();
}

async function showMenuError(title: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await showMessage({
    type: "error",
    title,
    message,
    buttons: ["OK"],
    noLink: true,
  });
}

function sendMenu(action: MenuAction, path?: string): void {
  const event: JinEvent = path
    ? { type: "menu", action, path }
    : { type: "menu", action };
  sendEvent(event);
}

function showAbout(): void {
  const detail = [
    "Architecture-first coding agent.",
    "",
    `Electron ${process.versions.electron}`,
    `Chromium ${process.versions.chrome}`,
    `Node ${process.versions.node}`,
    "",
    "Intent → L0/L1 architecture → one approval → code → conformance.",
  ].join("\n");
  void showMessage({
    type: "info",
    title: "About Jin",
    message: `Jin ${app.getVersion()}`,
    detail,
    buttons: ["OK"],
    noLink: true,
  });
}

async function installDriverFromMenu(): Promise<void> {
  if (!activeSession) {
    await showMessage({
      type: "info",
      title: "No project open",
      message: "Open a Jin project before installing the team merge driver.",
      buttons: ["OK"],
    });
    return;
  }
  try {
    const result = await activeSession.installMergeDriver();
    await showMessage({
      type: result.ok ? "info" : "error",
      title: "Jin WAL merge driver",
      message: result.message,
      buttons: ["OK"],
      noLink: true,
    });
  } catch (error) {
    await showMenuError("Could not install merge driver", error);
  }
}

function recentProjectMenu(): MenuItemConstructorOptions[] {
  const projects = recentProjects();
  if (projects.length === 0) {
    return [{ label: "No recent projects", enabled: false }];
  }
  return projects.map((project) => ({
    label: project.name,
    sublabel: project.path,
    click: () => {
      void openProjectPath(project.path).catch((error: unknown) =>
        showMenuError("Could not open project", error),
      );
    },
  }));
}

function buildApplicationMenu(): Menu {
  const isMac = process.platform === "darwin";
  const hasProject = Boolean(activeSession);
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => sendMenu("settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push({
    label: "File",
    submenu: [
      {
        label: "New Project…",
        accelerator: "CmdOrCtrl+Shift+N",
        click: () => {
          void createProjectFromDialog().catch((error: unknown) =>
            showMenuError("Could not create project", error),
          );
        },
      },
      {
        label: "Open Project…",
        accelerator: "CmdOrCtrl+O",
        click: () => {
          void openProjectFromDialog().catch((error: unknown) =>
            showMenuError("Could not open project", error),
          );
        },
      },
      { label: "Open Recent", submenu: recentProjectMenu() },
      { type: "separator" },
      {
        label: "Close Project",
        enabled: hasProject,
        click: () => {
          closeProject();
        },
      },
      ...(isMac
        ? []
        : ([
            { type: "separator" },
            {
              label: "Settings…",
              accelerator: "CmdOrCtrl+,",
              click: () => sendMenu("settings"),
            },
            { type: "separator" },
            { role: "quit", label: "Quit Jin" },
          ] satisfies MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  });

  template.push({
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      ...(VITE_DEV_SERVER_URL ? [{ role: "toggleDevTools" } as const] : []),
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });

  template.push({
    label: "Project",
    submenu: [
      {
        label: "Scan Source",
        accelerator: "CmdOrCtrl+Shift+S",
        enabled: hasProject,
        click: () => sendMenu("scan"),
      },
      { type: "separator" },
      {
        label: "Approve Current Proposal",
        accelerator: "CmdOrCtrl+Shift+Enter",
        enabled: hasProject,
        click: () => sendMenu("approve"),
      },
      {
        label: "Reject Current Proposal",
        enabled: hasProject,
        click: () => sendMenu("reject"),
      },
      { type: "separator" },
      {
        label: "Toggle Intent Panel",
        accelerator: "CmdOrCtrl+Alt+I",
        enabled: hasProject,
        click: () => sendMenu("toggle-intents"),
      },
      { type: "separator" },
      {
        label: "Install Git Merge Driver",
        enabled: hasProject,
        click: () => {
          void installDriverFromMenu();
        },
      },
    ],
  });

  template.push({
    label: "Help",
    submenu: [
      ...(isMac ? [] : ([{ label: "About Jin", click: showAbout }] as const)),
      {
        label: "Architecture WAL",
        click: () => {
          void shell.openExternal("https://github.com/");
        },
      },
    ],
  });

  return Menu.buildFromTemplate(template);
}

function rebuildApplicationMenu(): void {
  Menu.setApplicationMenu(buildApplicationMenu());
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getState, () => sessionState());

  ipcMain.handle(IPC_CHANNELS.openProject, async (_event, path?: unknown) => {
    if (typeof path === "string" && path.trim()) return openProjectPath(path);
    return openProjectFromDialog();
  });

  ipcMain.handle(IPC_CHANNELS.createProject, () => createProjectFromDialog());

  ipcMain.handle(IPC_CHANNELS.closeProject, () => closeProject());

  ipcMain.handle(IPC_CHANNELS.chooseProjectDirectory, () =>
    pickProjectDirectory("Choose a project folder"),
  );

  ipcMain.handle(IPC_CHANNELS.refresh, async () => requireSession().refresh());

  ipcMain.handle(IPC_CHANNELS.scan, async () => requireSession().scan());

  ipcMain.handle(IPC_CHANNELS.sendMessage, async (_event, text: unknown) => {
    if (typeof text !== "string") throw new Error("Message text must be a string.");
    return requireSession().sendMessage(text);
  });

  ipcMain.handle(
    IPC_CHANNELS.approveProposal,
    async (_event, id: unknown, note: unknown) => {
      if (typeof id !== "string") throw new Error("Proposal id must be a string.");
      return requireSession().approveProposal(
        id,
        typeof note === "string" ? note : "",
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.rejectProposal,
    async (_event, id: unknown, note: unknown) => {
      if (typeof id !== "string") throw new Error("Proposal id must be a string.");
      return requireSession().rejectProposal(
        id,
        typeof note === "string" ? note : "",
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.retryImplementation,
    async (_event, versionId: unknown) => {
      if (versionId !== undefined && typeof versionId !== "string") {
        throw new Error("Version id must be a string.");
      }
      return requireSession().retryImplementation(versionId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.cancelAgent, () => {
    requireSession().cancelAgent();
  });

  ipcMain.handle(IPC_CHANNELS.getFileTree, (): FileNode =>
    requireSession().getFileTree(),
  );

  ipcMain.handle(IPC_CHANNELS.readFile, (_event, path: unknown): FileContent => {
    if (typeof path !== "string" || !path) throw new Error("A file path is required.");
    return requireSession().readFile(path);
  });

  ipcMain.handle(
    IPC_CHANNELS.openInExternalEditor,
    async (_event, path: unknown) => {
      if (typeof path !== "string" || !path) throw new Error("A file path is required.");
      const absolute = requireSession().resolveExternalFile(path);
      const error = await shell.openPath(absolute);
      if (error) throw new Error(error);
    },
  );

  ipcMain.handle(IPC_CHANNELS.getSettings, (): AppSettings => requireSettings().get());

  ipcMain.handle(
    IPC_CHANNELS.saveSettings,
    (_event, patch: unknown): AppSettings => {
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw new Error("Settings patch must be an object.");
      }
      const settings = requireSettings().save(patch as SettingsPatch);
      applyNativeTheme(settings.theme);
      if (activeSession) {
        activeSession.setConfigTheme(settings.theme, settings.glass);
      }
      broadcastState();
      return settings;
    },
  );

  ipcMain.handle(IPC_CHANNELS.getTools, (): ToolsInfo =>
    activeSession ? activeSession.getTools() : emptyTools(),
  );

  ipcMain.handle(
    IPC_CHANNELS.refreshTools,
    async (): Promise<ToolsInfo> =>
      activeSession ? activeSession.refreshTools() : emptyTools(),
  );

  ipcMain.handle(IPC_CHANNELS.installMergeDriver, async () => {
    if (!activeSession) {
      return { ok: false, message: "Open a project first." };
    }
    return activeSession.installMergeDriver();
  });

  ipcMain.handle(IPC_CHANNELS.mergeInstructions, (): string => {
    if (!activeSession) return "Open a project first.";
    return activeSession.mergeInstructions();
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: "Jin",
    backgroundColor: "#0a0d14",
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  mainWindow = win;

  win.once("ready-to-show", () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    if (url === current) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (VITE_DEV_SERVER_URL) {
    void win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(join(RENDERER_DIST, "index.html"));
  }

  return win;
}

function initializeApplication(): void {
  appDatabase = openAppDatabase(join(app.getPath("userData"), "jin.db"));
  settingsStore = new SettingsStore(appDatabase);
  applyNativeTheme(settingsStore.get().theme);
  registerIpcHandlers();
  rebuildApplicationMenu();
  createWindow();
}

const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    app.setName("Jin");
    initializeApplication();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    activeSession?.close();
    activeSession = null;
    if (appDatabase) {
      try {
        closeAppDatabase(appDatabase);
      } catch {
        // best effort
      }
      appDatabase = null;
    }
  });
}
