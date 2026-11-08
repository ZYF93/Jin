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
import { translate, type MessageKey, type TranslationParams } from "../shared/i18n";
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
  type JinEvent,
  type LspInstallResult,
  type MarketplaceSearchResult,
  type McpCallResult,
  type ProviderModelCatalog,
  type ProviderModelRequest,
  type RecentProject,
  type ReuseCandidate,
  type SettingsPatch,
  type ToolsInfo,
  type UpdateState,
  type VersionReplay,
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
import {
  LicenseGatedServerError,
  LspMarketplace,
  NoStandaloneServerError,
} from "./core/lsp/marketplace";
import { SettingsStore } from "./core/settings/app-settings";
import { UpdateService } from "./core/update/update-service";
import { fetchModelCatalog, ModelCatalogError } from "./core/agent/model-catalog";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitShow,
  gitStage,
  gitStatus,
  gitUnstage,
} from "./core/git/service";

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
let lspMarketplace: LspMarketplace | null = null;
let updateService: UpdateService | null = null;
let activeSession: ProjectSession | null = null;

function t(key: MessageKey, params?: TranslationParams): string {
  const language = settingsStore?.get().language ?? "en";
  return translate(language, key, params);
}

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
    language: "en",
    theme: "dark",
    glass: "subtle",
    provider: {
      kind: "none",
      baseUrl: "",
      model: "",
      hasApiKey: false,
      reasoningEffort: "auto",
      contextWindow: 128_000,
      compactionRatio: 0.8,
    },
    agent: {
      runtime: "custom",
      autoImplement: true,
      semanticScan: true,
      temperature: 0.2,
      maxTokens: 8000,
    },
    identity: { actorId: "user:uninitialized", name: t("common.jinUser"), email: "" },
    ui: { reduceMotion: false },
    updates: { autoCheck: true, feedUrl: "" },
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
      message: t("scan.idle"),
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
    metrics: {
      approval: { count: 0, averageMs: null, medianMs: null },
      drift: { implemented: 0, drifted: 0, rate: null },
      reuse: { applicable: 0, passed: 0, skipped: 0, failed: 0, rate: null },
      usage: {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        pricedCalls: 0,
      },
    },
    context: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      model: emptySettings().provider.model,
      updatedAt: null,
    },
    agent: { phase: "idle", message: t("scan.ready") },
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
  if (!activeSession) throw new Error(t("error.openProjectFirst"));
  return activeSession;
}

function requireSettings(): SettingsStore {
  if (!settingsStore) throw new Error(t("error.settingsNotReady"));
  return settingsStore;
}

function requireDatabase(): AppDatabase {
  if (!appDatabase) throw new Error(t("error.databaseNotReady"));
  return appDatabase;
}

function requireMarketplace(): LspMarketplace {
  if (!lspMarketplace) throw new Error(t("error.marketplaceNotReady"));
  return lspMarketplace;
}

function requireUpdateService(): UpdateService {
  if (!updateService) {
    throw new Error(t("settings.updateChecking"));
  }
  return updateService;
}

function applyNativeTheme(theme: AppSettings["theme"]): void {
  nativeTheme.themeSource = theme;
}

function showMessage(options: MessageBoxOptions) {
  return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

function showOpenDialog(options: OpenDialogOptions) {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
}

async function pickProjectDirectory(title: string): Promise<string | null> {
  const result = await showOpenDialog({
    title,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: t("dialog.chooseFolder"),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function confirmInitialize(root: string): Promise<boolean> {
  const result = await showMessage({
    type: "question",
    title: t("dialog.initializeTitle"),
    message: t("dialog.initializeMessage", { root }),
    detail: t("dialog.initializeDetail"),
    buttons: [t("dialog.initialize"), t("common.cancel")],
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
  if (!existsSync(selected)) {
    throw new Error(t("error.folderMissing", { path: selected }));
  }
  if (!statSync(selected).isDirectory()) {
    throw new Error(t("error.notFolder", { path: selected }));
  }

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
    marketplace: requireMarketplace(),
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
  const path = await pickProjectDirectory(t("dialog.openProjectTitle"));
  if (!path) return sessionState();
  return openProjectPath(path);
}

async function createProjectFromDialog(): Promise<AppState> {
  const path = await pickProjectDirectory(t("dialog.newProjectTitle"));
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
    buttons: [t("dialog.ok")],
    noLink: true,
  });
}

function sendMenu(action: MenuAction, path?: string): void {
  const event: JinEvent = path ? { type: "menu", action, path } : { type: "menu", action };
  sendEvent(event);
}

function showAbout(): void {
  const detail = t("dialog.aboutDetail", {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  });
  void showMessage({
    type: "info",
    title: t("dialog.aboutTitle"),
    message: t("dialog.aboutMessage", { version: app.getVersion() }),
    detail,
    buttons: [t("dialog.ok")],
    noLink: true,
  });
}

async function installDriverFromMenu(): Promise<void> {
  if (!activeSession) {
    await showMessage({
      type: "info",
      title: t("dialog.noProject"),
      message: t("dialog.installDriverFirst"),
      buttons: [t("dialog.ok")],
    });
    return;
  }
  try {
    const result = await activeSession.installMergeDriver();
    await showMessage({
      type: result.ok ? "info" : "error",
      title: t("dialog.driverTitle"),
      message: result.message,
      buttons: [t("dialog.ok")],
      noLink: true,
    });
  } catch (error) {
    await showMenuError(t("dialog.installDriverError"), error);
  }
}

function recentProjectMenu(): MenuItemConstructorOptions[] {
  const projects = recentProjects();
  if (projects.length === 0) {
    return [{ label: t("menu.noRecent"), enabled: false }];
  }
  return projects.map((project) => ({
    label: project.name,
    sublabel: project.path,
    click: () => {
      void openProjectPath(project.path).catch((error: unknown) =>
        showMenuError(t("dialog.openError"), error),
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
        { role: "about", label: t("menu.about") },
        { type: "separator" },
        {
          label: t("menu.settings"),
          accelerator: "CmdOrCtrl+,",
          click: () => sendMenu("settings"),
        },
        { type: "separator" },
        { role: "services", label: t("menu.services") },
        { type: "separator" },
        { role: "hide", label: t("menu.hide") },
        { role: "hideOthers", label: t("menu.hideOthers") },
        { role: "unhide", label: t("menu.showAll") },
        { type: "separator" },
        { role: "quit", label: t("menu.quit") },
      ],
    });
  }

  template.push({
    label: t("menu.file"),
    submenu: [
      {
        label: t("menu.newProject"),
        accelerator: "CmdOrCtrl+Shift+N",
        click: () => {
          void createProjectFromDialog().catch((error: unknown) =>
            showMenuError(t("dialog.createError"), error),
          );
        },
      },
      {
        label: t("menu.openProject"),
        accelerator: "CmdOrCtrl+O",
        click: () => {
          void openProjectFromDialog().catch((error: unknown) =>
            showMenuError(t("dialog.openError"), error),
          );
        },
      },
      { label: t("menu.openRecent"), submenu: recentProjectMenu() },
      { type: "separator" },
      {
        label: t("menu.closeProject"),
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
              label: t("menu.settings"),
              accelerator: "CmdOrCtrl+,",
              click: () => sendMenu("settings"),
            },
            { type: "separator" },
            { role: "quit", label: t("menu.quit") },
          ] satisfies MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: t("menu.edit"),
    submenu: [
      { role: "undo", label: t("menu.undo") },
      { role: "redo", label: t("menu.redo") },
      { type: "separator" },
      { role: "cut", label: t("menu.cut") },
      { role: "copy", label: t("menu.copy") },
      { role: "paste", label: t("menu.paste") },
      { role: "pasteAndMatchStyle", label: t("menu.pasteMatch") },
      { role: "delete", label: t("menu.delete") },
      { role: "selectAll", label: t("menu.selectAll") },
    ],
  });

  template.push({
    label: t("menu.view"),
    submenu: [
      { role: "reload", label: t("menu.reload") },
      { role: "forceReload", label: t("menu.forceReload") },
      ...(VITE_DEV_SERVER_URL
        ? [{ role: "toggleDevTools", label: t("menu.devTools") } as const]
        : []),
      { type: "separator" },
      { role: "resetZoom", label: t("menu.resetZoom") },
      { role: "zoomIn", label: t("menu.zoomIn") },
      { role: "zoomOut", label: t("menu.zoomOut") },
      { type: "separator" },
      { role: "togglefullscreen", label: t("menu.fullscreen") },
    ],
  });

  template.push({
    label: t("menu.project"),
    submenu: [
      {
        label: t("menu.commandPalette"),
        accelerator: "CmdOrCtrl+K",
        click: () => sendMenu("command-palette"),
      },
      { type: "separator" },
      {
        label: t("menu.scan"),
        accelerator: "CmdOrCtrl+Shift+S",
        enabled: hasProject,
        click: () => sendMenu("scan"),
      },
      { type: "separator" },
      {
        label: t("menu.approve"),
        accelerator: "CmdOrCtrl+Shift+Enter",
        enabled: hasProject,
        click: () => sendMenu("approve"),
      },
      {
        label: t("menu.reject"),
        enabled: hasProject,
        click: () => sendMenu("reject"),
      },
      { type: "separator" },
      {
        label: t("menu.toggleIntents"),
        accelerator: "CmdOrCtrl+Alt+I",
        enabled: hasProject,
        click: () => sendMenu("toggle-intents"),
      },
      { type: "separator" },
      {
        label: t("menu.installDriver"),
        enabled: hasProject,
        click: () => {
          void installDriverFromMenu();
        },
      },
    ],
  });

  template.push({
    label: t("menu.help"),
    submenu: [
      ...(isMac ? [] : ([{ label: t("menu.about"), click: showAbout }] as const)),
      {
        label: t("menu.wal"),
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
    pickProjectDirectory(t("dialog.chooseProjectTitle")),
  );

  ipcMain.handle(IPC_CHANNELS.refresh, async () => requireSession().refresh());

  ipcMain.handle(IPC_CHANNELS.scan, async () => requireSession().scan());

  ipcMain.handle(IPC_CHANNELS.amendArchitecture, async (_event, versionId: unknown) => {
    if (typeof versionId !== "string" || !versionId) {
      throw new Error(t("error.versionIdRequired"));
    }
    return requireSession().amendArchitecture(versionId);
  });

  ipcMain.handle(IPC_CHANNELS.mergeIntent, async () => requireSession().mergeIntent());

  ipcMain.handle(IPC_CHANNELS.sendMessage, async (_event, text: unknown) => {
    if (typeof text !== "string") throw new Error(t("error.messageTextString"));
    return requireSession().sendMessage(text);
  });

  ipcMain.handle(IPC_CHANNELS.approveProposal, async (_event, id: unknown, note: unknown) => {
    if (typeof id !== "string") throw new Error(t("error.proposalIdString"));
    return requireSession().approveProposal(id, typeof note === "string" ? note : "");
  });

  ipcMain.handle(IPC_CHANNELS.rejectProposal, async (_event, id: unknown, note: unknown) => {
    if (typeof id !== "string") throw new Error(t("error.proposalIdString"));
    return requireSession().rejectProposal(id, typeof note === "string" ? note : "");
  });

  ipcMain.handle(IPC_CHANNELS.retryImplementation, async (_event, versionId: unknown) => {
    if (versionId !== undefined && typeof versionId !== "string") {
      throw new Error(t("error.versionIdString"));
    }
    return requireSession().retryImplementation(versionId);
  });

  ipcMain.handle(IPC_CHANNELS.replayVersion, (_event, versionId: unknown): VersionReplay => {
    if (typeof versionId !== "string" || !versionId) {
      throw new Error(t("error.versionIdRequired"));
    }
    return requireSession().replayVersion(versionId);
  });

  ipcMain.handle(IPC_CHANNELS.cancelAgent, () => {
    requireSession().cancelAgent();
  });

  ipcMain.handle(IPC_CHANNELS.getFileTree, (): FileNode => requireSession().getFileTree());

  ipcMain.handle(IPC_CHANNELS.readFile, (_event, path: unknown): FileContent => {
    if (typeof path !== "string" || !path) {
      throw new Error(t("error.filePathRequired"));
    }
    return requireSession().readFile(path);
  });

  ipcMain.handle(IPC_CHANNELS.openInExternalEditor, async (_event, path: unknown) => {
    if (typeof path !== "string" || !path) {
      throw new Error(t("error.filePathRequired"));
    }
    const absolute = requireSession().resolveExternalFile(path);
    const error = await shell.openPath(absolute);
    if (error) throw new Error(error);
  });

  ipcMain.handle(IPC_CHANNELS.getSettings, (): AppSettings => requireSettings().get());

  ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, patch: unknown): AppSettings => {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new Error(t("error.settingsObject"));
    }
    const settings = requireSettings().save(patch as SettingsPatch);
    applyNativeTheme(settings.theme);
    if (activeSession) {
      activeSession.setConfigTheme(settings.theme, settings.glass);
    }
    if (updateService) {
      updateService.configure({
        autoCheck: settings.updates.autoCheck,
        feedUrl: settings.updates.feedUrl,
      });
    }
    rebuildApplicationMenu();
    broadcastState();
    return settings;
  });

  ipcMain.handle(IPC_CHANNELS.getUpdateState, (): UpdateState => requireUpdateService().getState());
  ipcMain.handle(IPC_CHANNELS.checkForUpdates, (): Promise<UpdateState> =>
    requireUpdateService().check(),
  );
  ipcMain.handle(IPC_CHANNELS.downloadUpdate, (): Promise<UpdateState> =>
    requireUpdateService().download(),
  );
  ipcMain.handle(IPC_CHANNELS.installUpdate, (): void => {
    if (!requireUpdateService().install()) {
      throw new Error(t("settings.updateError", { message: "No downloaded update" }));
    }
  });

  ipcMain.handle(IPC_CHANNELS.getTools, (): ToolsInfo =>
    activeSession ? activeSession.getTools() : emptyTools(),
  );

  ipcMain.handle(IPC_CHANNELS.refreshTools, async (): Promise<ToolsInfo> =>
    activeSession ? activeSession.refreshTools() : emptyTools(),
  );

  ipcMain.handle(
    IPC_CHANNELS.searchExtensions,
    async (_event, query: unknown, limit: unknown): Promise<MarketplaceSearchResult> => {
      if (typeof query !== "string") throw new Error(t("error.queryString"));
      const pageSize =
        typeof limit === "number" && Number.isFinite(limit)
          ? Math.max(1, Math.min(30, Math.trunc(limit)))
          : 12;
      return requireMarketplace().search(query, pageSize);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.installLspExtension,
    async (_event, id: unknown): Promise<LspInstallResult> => {
      if (typeof id !== "string" || !id) throw new Error(t("error.extensionId"));
      try {
        const outcome = await requireMarketplace().install(id);
        const lsp = activeSession?.refreshLsp() ?? [];
        return {
          ok: true,
          message: t("settings.marketplace.installed", {
            name: outcome.extension.displayName,
            version: outcome.extension.version,
          }),
          extension: outcome.extension,
          lsp,
        };
      } catch (error) {
        if (error instanceof LicenseGatedServerError) {
          return {
            ok: false,
            message: t("settings.marketplace.licenseGated"),
            extension: null,
            lsp: activeSession?.refreshLsp() ?? [],
          };
        }
        if (error instanceof NoStandaloneServerError) {
          return {
            ok: false,
            message: t("settings.marketplace.noServer"),
            extension: null,
            lsp: activeSession?.refreshLsp() ?? [],
          };
        }
        return {
          ok: false,
          message: t("settings.marketplace.failed", {
            message: error instanceof Error ? error.message : String(error),
          }),
          extension: null,
          lsp: activeSession?.refreshLsp() ?? [],
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.uninstallLspExtension,
    async (_event, id: unknown): Promise<LspInstallResult> => {
      if (typeof id !== "string" || !id) throw new Error(t("error.extensionId"));
      const removed = requireMarketplace().uninstall(id);
      const lsp = activeSession?.refreshLsp() ?? [];
      return {
        ok: Boolean(removed),
        message: removed
          ? t("settings.marketplace.uninstalled", { name: removed.displayName })
          : t("settings.marketplace.notInstalled", { id }),
        extension: null,
        lsp,
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.searchCode,
    (_event, query: unknown, limit: unknown): ReuseCandidate[] => {
      if (typeof query !== "string") throw new Error(t("error.queryString"));
      const max = typeof limit === "number" && Number.isFinite(limit) ? limit : 12;
      return requireSession().searchCode(query, Math.max(1, Math.min(30, Math.trunc(max))));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.listModels,
    async (_event, input: unknown): Promise<ProviderModelCatalog> => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new ModelCatalogError("Invalid model catalog request.");
      }
      const request = input as Partial<ProviderModelRequest>;
      if (request.kind !== "openai-compatible" && request.kind !== "ollama") {
        throw new ModelCatalogError("Choose a provider before fetching models.");
      }
      if (typeof request.baseUrl !== "string" || !request.baseUrl.trim()) {
        throw new ModelCatalogError("Enter the provider base URL first.");
      }
      if (
        request.apiKey !== undefined &&
        request.apiKey !== null &&
        typeof request.apiKey !== "string"
      ) {
        throw new ModelCatalogError("Invalid API key.");
      }
      const storedKey = requireSettings().getProviderApiKey();
      const apiKey =
        request.apiKey === undefined
          ? storedKey
          : request.apiKey === null
            ? null
            : request.apiKey.trim() || null;
      return fetchModelCatalog({
        kind: request.kind,
        baseUrl: request.baseUrl.trim(),
        apiKey,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.mcpCall,
    async (_event, server: unknown, tool: unknown, args: unknown): Promise<McpCallResult> => {
      if (typeof server !== "string" || !server) {
        throw new Error(t("error.mcpServer"));
      }
      if (typeof tool !== "string" || !tool) throw new Error(t("error.mcpTool"));
      if (
        args !== undefined &&
        (typeof args !== "object" || args === null || Array.isArray(args))
      ) {
        throw new Error(t("error.mcpArgs"));
      }
      return requireSession().callMcpTool(
        server,
        tool,
        (args as Record<string, unknown> | undefined) ?? {},
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.gitStatus, (): Promise<GitStatus> =>
    gitStatus(requireSession().root),
  );

  ipcMain.handle(IPC_CHANNELS.gitBranches, (): Promise<GitBranchList> =>
    gitBranches(requireSession().root),
  );

  ipcMain.handle(
    IPC_CHANNELS.gitCheckout,
    (_event, name: unknown, create: unknown, dirtyAction: unknown): Promise<GitActionResult> => {
      if (typeof name !== "string" || !name.trim()) {
        throw new Error(t("error.gitBranch"));
      }
      if (create !== undefined && typeof create !== "boolean") {
        throw new Error(t("error.gitBranch"));
      }
      if (dirtyAction !== undefined && dirtyAction !== "carry" && dirtyAction !== "stash") {
        throw new Error(t("error.gitBranch"));
      }
      return gitCheckout(requireSession().root, name, create === true, dirtyAction);
    },
  );

  ipcMain.handle(IPC_CHANNELS.gitLog, (_event, limit: unknown): Promise<GitCommit[]> => {
    const count = typeof limit === "number" && Number.isFinite(limit) ? limit : 30;
    return gitLog(requireSession().root, count);
  });

  ipcMain.handle(IPC_CHANNELS.gitShow, (_event, hash: unknown): Promise<GitCommitDetail> => {
    if (typeof hash !== "string" || !hash.trim()) {
      throw new Error(t("error.gitHashRequired"));
    }
    return gitShow(requireSession().root, hash);
  });

  const gitPaths = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
      throw new Error(t("error.gitPaths"));
    }
    if (value.length > 1_000) throw new Error(t("error.gitPaths"));
    return value as string[];
  };

  ipcMain.handle(IPC_CHANNELS.gitStage, (_event, paths: unknown): Promise<GitActionResult> =>
    gitStage(requireSession().root, gitPaths(paths)),
  );

  ipcMain.handle(IPC_CHANNELS.gitUnstage, (_event, paths: unknown): Promise<GitActionResult> =>
    gitUnstage(requireSession().root, gitPaths(paths)),
  );

  ipcMain.handle(IPC_CHANNELS.gitCommit, (_event, message: unknown): Promise<GitActionResult> => {
    if (typeof message !== "string") throw new Error(t("error.gitCommitMessage"));
    return gitCommit(requireSession().root, message);
  });

  ipcMain.handle(IPC_CHANNELS.gitPush, (): Promise<GitActionResult> =>
    gitPush(requireSession().root),
  );

  ipcMain.handle(IPC_CHANNELS.gitPull, (): Promise<GitActionResult> =>
    gitPull(requireSession().root),
  );

  ipcMain.handle(IPC_CHANNELS.gitFetch, (): Promise<GitActionResult> =>
    gitFetch(requireSession().root),
  );

  ipcMain.handle(IPC_CHANNELS.installMergeDriver, async () => {
    if (!activeSession) {
      return { ok: false, message: t("dialog.openProjectFirst") };
    }
    return activeSession.installMergeDriver();
  });

  ipcMain.handle(IPC_CHANNELS.mergeInstructions, (): string => {
    if (!activeSession) return t("dialog.openProjectFirst");
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

/** Headless packaged smoke used by CI: verify the renderer and preload load. */
function runPackagedSmoke(win: BrowserWindow): void {
  let settled = false;
  const finish = (ok: boolean, detail: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    console.log(`JIN_SMOKE_${ok ? "OK" : "FAIL"}: ${detail}`);
    setTimeout(() => app.exit(ok ? 0 : 1), 150);
  };
  const timer = setTimeout(
    () => finish(false, "renderer did not finish loading within 30s"),
    30_000,
  );
  timer.unref?.();
  win.webContents.once("did-fail-load", (_event, code, description, url) => {
    finish(false, `load failed (${code}) ${description} ${url}`);
  });
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void win.webContents
        .executeJavaScript("typeof window.jin?.getState === 'function'")
        .then((bridge) =>
          finish(
            bridge === true,
            `bridge=${String(bridge)} version=${app.getVersion()} packaged=${app.isPackaged} platform=${process.platform}`,
          ),
        )
        .catch((error: unknown) =>
          finish(false, error instanceof Error ? error.message : String(error)),
        );
    }, 1_000);
  });
}

function initializeApplication(): void {
  appDatabase = openAppDatabase(join(app.getPath("userData"), "jin.db"));
  settingsStore = new SettingsStore(appDatabase);
  lspMarketplace = new LspMarketplace(join(app.getPath("userData"), "lsp-extensions"));
  const settings = settingsStore.get();
  applyNativeTheme(settings.theme);
  updateService = new UpdateService({
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    feedUrl: settings.updates.feedUrl,
    envFeedUrl: process.env.JIN_UPDATE_FEED_URL,
    autoCheck: settings.updates.autoCheck,
    devConfigPath: join(app.getPath("userData"), "dev-app-update.yml"),
    onState: (update) => sendEvent({ type: "update", update }),
  });
  registerIpcHandlers();
  rebuildApplicationMenu();
  const win = createWindow();
  if (process.env.JIN_SMOKE_TEST === "1") {
    runPackagedSmoke(win);
    return;
  }
  void updateService.initialize().then(() => {
    if (!updateService?.autoCheckEnabled) return;
    const timer = setTimeout(() => {
      if (updateService?.getState().canCheck) void updateService.check();
    }, 4_000);
    timer.unref?.();
  });
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
