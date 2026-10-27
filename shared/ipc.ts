import type {
  ArchDiff,
  NodeChange,
  RiskHint,
} from "./arch/diff";
import type {
  ArchNode,
  ArchOp,
  ArchSnapshot,
  Decision,
  FoldResult,
  Intent,
  Touch,
  VersionStatus,
  WalConflict,
} from "./arch/types";

export type ThemeMode = "dark" | "light" | "system";
export type GlassStrength = "off" | "subtle" | "medium" | "strong";

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
}

export interface ProjectInfo {
  root: string;
  name: string;
  languages: string[];
  scanRoots: string[];
  gitBranch: string | null;
  initialized: boolean;
}

export interface ProviderSettings {
  kind: "none" | "openai-compatible" | "ollama";
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface AppSettings {
  theme: ThemeMode;
  glass: GlassStrength;
  provider: ProviderSettings;
  agent: {
    autoImplement: boolean;
    temperature: number;
    maxTokens: number;
  };
  identity: {
    actorId: string;
    name: string;
    email: string;
  };
  ui: {
    reduceMotion: boolean;
  };
}

export interface SettingsPatch {
  theme?: ThemeMode;
  glass?: GlassStrength;
  providerKind?: ProviderSettings["kind"];
  providerBaseUrl?: string;
  providerModel?: string;
  /** Omit to leave unchanged; pass null to delete the stored key. */
  apiKey?: string | null;
  autoImplement?: boolean;
  temperature?: number;
  maxTokens?: number;
  userName?: string;
  userEmail?: string;
  reduceMotion?: boolean;
}

export interface FileNode {
  name: string;
  /** Project-relative path. Directories use `/` separators and no trailing slash. */
  path: string;
  type: "file" | "directory";
  size?: number;
  extension?: string;
  children?: FileNode[];
}

export interface FileContent {
  path: string;
  content: string;
  language: string;
  size: number;
  truncated: boolean;
}

export type ScanPhase = "idle" | "scanning" | "ready" | "failed";

export interface ScanStatus {
  phase: ScanPhase;
  files: number;
  symbols: number;
  nodes: number;
  edges: number;
  message: string;
  updatedAt: string | null;
}

export type LspAvailability = "available" | "missing" | "unknown";

export interface LspStatus {
  id: string;
  language: string;
  server: string;
  command: string;
  status: LspAvailability;
  installHint: string;
  detail: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  scope: "project" | "user";
  path: string;
}

export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http" | "sse";
  target: string;
  status: "configured" | "ready" | "error" | "disabled";
  tools: string[];
  error: string | null;
}

export interface ToolsInfo {
  builtin: string[];
  skills: SkillInfo[];
  mcpServers: McpServerInfo[];
  updatedAt: string;
}

export interface WalInfo {
  records: number;
  conflicts: WalConflict[];
  warnings: string[];
  lastRecordId: string | null;
}

export type AgentPhase =
  | "idle"
  | "planning"
  | "implementing"
  | "verifying"
  | "error";

export interface AgentStatus {
  phase: AgentPhase;
  message: string;
  versionId?: string;
}

export type ChatRole = "user" | "assistant" | "system" | "tool";

export type ChatMessageKind =
  | "text"
  | "proposal"
  | "implementation"
  | "scan"
  | "error";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  kind: ChatMessageKind;
  content: string;
  createdAt: string;
  proposalId?: string;
  details?: string;
}

export interface ReuseCandidate {
  path: string;
  symbol: string;
  score: number;
  reason: string;
  snippet: string;
}

export interface ReusePlan {
  query: string;
  summary: string;
  candidates: ReuseCandidate[];
  createdAt: string;
}

export interface ProposalView {
  /** The version id is also the proposal id. */
  id: string;
  intent: Intent;
  ops: ArchOp[];
  touches: Touch[];
  /** Reviewed snapshots, included so the renderer can draw the graph diff. */
  baseSnapshot: ArchSnapshot;
  targetSnapshot: ArchSnapshot;
  baseHash: string;
  targetHash: string;
  diffHash: string;
  diff: ArchDiff;
  risks: RiskHint[];
  reusePlan: ReusePlan | null;
  createdAt: string;
  status: "in_review" | "stale" | "approved" | "rejected";
}

export interface AppState {
  project: ProjectInfo | null;
  snapshot: ArchSnapshot | null;
  proposal: ProposalView | null;
  messages: ChatMessage[];
  settings: AppSettings;
  recentProjects: RecentProject[];
  scan: ScanStatus;
  lsp: LspStatus[];
  tools: ToolsInfo;
  wal: WalInfo;
  agent: AgentStatus;
  fold: {
    conflicts: WalConflict[];
    warnings: string[];
  } | null;
}

export type MenuAction =
  | "open-project"
  | "new-project"
  | "settings"
  | "scan"
  | "toggle-intents"
  | "toggle-chat"
  | "approve"
  | "reject"
  | "about";

export type JinEvent =
  | { type: "state"; state: AppState }
  | { type: "agent"; status: AgentStatus; state: AppState }
  | { type: "menu"; action: MenuAction; path?: string }
  | { type: "error"; message: string };

/**
 * The only IPC surface between the renderer and the main process. Keep these
 * names stable: preload exposes them as the typed `window.jin` bridge.
 */
export const IPC_CHANNELS = {
  getState: "jin:get-state",
  openProject: "jin:open-project",
  createProject: "jin:create-project",
  closeProject: "jin:close-project",
  chooseProjectDirectory: "jin:choose-project-directory",
  refresh: "jin:refresh",
  scan: "jin:scan",
  sendMessage: "jin:send-message",
  approveProposal: "jin:approve-proposal",
  rejectProposal: "jin:reject-proposal",
  retryImplementation: "jin:retry-implementation",
  cancelAgent: "jin:cancel-agent",
  getFileTree: "jin:get-file-tree",
  readFile: "jin:read-file",
  openInExternalEditor: "jin:open-in-external-editor",
  getSettings: "jin:get-settings",
  saveSettings: "jin:save-settings",
  getTools: "jin:get-tools",
  refreshTools: "jin:refresh-tools",
  installMergeDriver: "jin:install-merge-driver",
  mergeInstructions: "jin:merge-instructions",
  event: "jin:event",
} as const;

export interface JinBridge {
  getState(): Promise<AppState>;
  openProject(path?: string): Promise<AppState>;
  createProject(): Promise<AppState>;
  closeProject(): Promise<AppState>;
  chooseProjectDirectory(): Promise<string | null>;
  refresh(): Promise<AppState>;
  scan(): Promise<AppState>;
  sendMessage(text: string): Promise<AppState>;
  approveProposal(id: string, note?: string): Promise<AppState>;
  rejectProposal(id: string, note?: string): Promise<AppState>;
  retryImplementation(versionId?: string): Promise<AppState>;
  cancelAgent(): Promise<void>;
  getFileTree(): Promise<FileNode>;
  readFile(path: string): Promise<FileContent>;
  openInExternalEditor(path: string): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: SettingsPatch): Promise<AppSettings>;
  getTools(): Promise<ToolsInfo>;
  refreshTools(): Promise<ToolsInfo>;
  installMergeDriver(): Promise<{ ok: boolean; message: string }>;
  mergeInstructions(): Promise<string>;
  onEvent(listener: (event: JinEvent) => void): () => void;
}

/** Serializable node helper used by the renderer without importing the model. */
export type RendererNodeChange = NodeChange;

/** Re-export a few model types that renderer components use frequently. */
export type {
  ArchNode,
  ArchOp,
  ArchSnapshot,
  Decision,
  FoldResult,
  Intent,
  VersionStatus,
};
