import type { ArchDiff, NodeChange, RiskHint } from "./arch/diff";
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
} from "./ledger/types";
import type { Language } from "./i18n";

export type { Language } from "./i18n";
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

export type ReasoningEffort = "auto" | "low" | "medium" | "high";

export interface ProviderSettings {
  kind: "none" | "openai-compatible" | "ollama";
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  /** Reasoning effort forwarded to OpenAI-compatible providers. */
  reasoningEffort?: ReasoningEffort;
  /** Model context window in tokens, used by the composer meter and planner budget. */
  contextWindow?: number;
  /** Fraction of the context window at which Jin compresses architecture context. */
  compactionRatio?: number;
  /** Optional USD price per million prompt tokens, used for local cost metrics. */
  inputPricePerMillion?: number;
  /** Optional USD price per million completion tokens, used for local cost metrics. */
  outputPricePerMillion?: number;
}

/** One model advertised by a provider's model endpoint. */
export interface ProviderModel {
  id: string;
  name: string;
  /** `auto` is always present; extra values are advertised by the model/provider. */
  reasoningEfforts: ReasoningEffort[];
  /**
   * Where `reasoningEfforts` came from: provider metadata, a known model-family
   * inference, or Jin's permissive default for models with no metadata.
   */
  reasoningSource?: "remote" | "inferred" | "default";
  contextWindow?: number;
}

/** Remote model and capability catalog for the settings and composer pickers. */
export interface ProviderModelCatalog {
  provider: ProviderSettings["kind"];
  models: ProviderModel[];
  fetchedAt: string;
  warning?: string;
}

/** Draft provider details used to fetch models before settings are saved. */
export interface ProviderModelRequest {
  kind: ProviderSettings["kind"];
  baseUrl: string;
  /** `undefined` uses the stored key, `null` explicitly performs an anonymous request. */
  apiKey?: string | null;
}

export interface AppSettings {
  /** Interface and native-menu language. WAL content keeps its authored language. */
  language: Language;
  theme: ThemeMode;
  glass: GlassStrength;
  provider: ProviderSettings;
  agent: {
    /** Refine L1 kinds, responsibilities and domain tags with the configured model during a manual scan. */
    semanticScan: boolean;
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
  updates: {
    /** Check the configured feed shortly after launch. */
    autoCheck: boolean;
    /** Generic provider feed URL. Empty means use electron-builder's app-update.yml. */
    feedUrl: string;
  };
}

export interface SettingsPatch {
  language?: Language;
  theme?: ThemeMode;
  glass?: GlassStrength;
  providerKind?: ProviderSettings["kind"];
  providerBaseUrl?: string;
  providerModel?: string;
  providerReasoningEffort?: ReasoningEffort;
  /** Model context window in tokens. */
  providerContextWindow?: number;
  /** Fraction of the context window used as Jin's compaction threshold. */
  providerCompactionRatio?: number;
  /** USD per million prompt tokens. */
  providerInputPrice?: number;
  /** USD per million completion tokens. */
  providerOutputPrice?: number;
  /** Omit to leave unchanged; pass null to delete the stored key. */
  apiKey?: string | null;
  semanticScan?: boolean;
  temperature?: number;
  maxTokens?: number;
  userName?: string;
  userEmail?: string;
  reduceMotion?: boolean;
  updateAutoCheck?: boolean;
  updateFeedUrl?: string;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "disabled";

export type UpdateReason = "development" | "no-feed" | "unsupported" | "module-missing" | null;

/** Cross-platform auto-update state. The feed is generic, so any static host works. */
export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  percent: number | null;
  bytesPerSecond: number | null;
  transferred: number | null;
  total: number | null;
  checkedAt: string | null;
  message: string | null;
  reason: UpdateReason;
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
  feedUrl: string | null;
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

/** One changed path as reported by Git. */
export interface GitChange {
  path: string;
  /** Porcelain status letter: M, A, D, R, C, U, or ? for untracked. */
  status: string;
  staged: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  /** Repository top level; the project may be a subdirectory. */
  root: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  staged: GitChange[];
  unstaged: GitChange[];
  untracked: GitChange[];
  conflicted: GitChange[];
  remotes: string[];
  message: string | null;
}

/** One local or remote-tracking branch. Remote names keep their remote prefix. */
export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitBranchList {
  current: string | null;
  detached: boolean;
  local: GitBranch[];
  remote: GitBranch[];
}

export type GitDirtyCheckoutAction = "carry" | "stash";

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  email: string;
  date: string;
  refs: string[];
}

export interface GitCommitDetail extends GitCommit {
  body: string;
  files: Array<{ status: string; path: string }>;
  patch: string;
  truncated: boolean;
}

export interface GitActionResult {
  status: GitStatus;
  message: string;
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
  /** `path` means a system-installed server; `marketplace` means a VSIX download. */
  source?: "path" | "marketplace";
  extensionId?: string;
  version?: string;
  /** File extensions covered by this server. */
  extensions?: string[];
  installedAt?: string;
}

/** One VS Code Marketplace extension row in Settings → Tools. */
export interface MarketplaceExtension {
  id: string;
  publisher: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  installs: number;
  rating: number;
  lastUpdated: string;
  iconUrl?: string;
  verified: boolean;
  installed: boolean;
  installedVersion?: string;
  /** Set after Jin detected a standalone language-server entry. */
  server?: string | null;
}

export interface MarketplaceSearchResult {
  total: number;
  extensions: MarketplaceExtension[];
}

export interface LspInstallResult {
  ok: boolean;
  message: string;
  extension: MarketplaceExtension | null;
  lsp: LspStatus[];
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

export interface McpCallResult {
  server: string;
  tool: string;
  isError: boolean;
  content: unknown;
  durationMs: number;
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

/** Intent creation → first approval decision. Rejected turns are excluded. */
export interface ApprovalMetrics {
  count: number;
  averageMs: number | null;
  medianMs: number | null;
}

/** Drift among versions whose latest implementation was checked. */
export interface DriftMetrics {
  implemented: number;
  drifted: number;
  rate: number | null;
}

/** Structural reuse guard results from each version's latest implementation. */
export interface ReuseMetrics {
  applicable: number;
  passed: number;
  skipped: number;
  failed: number;
  rate: number | null;
}

/** Local provider usage ledger. Cost is priced with the settings at call time. */
export interface UsageMetrics {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Number of calls recorded while prompt/completion prices were configured. */
  pricedCalls: number;
}

export interface ProjectMetrics {
  approval: ApprovalMetrics;
  drift: DriftMetrics;
  reuse: ReuseMetrics;
  usage: UsageMetrics;
}

export type AgentPhase = "idle" | "planning" | "implementing" | "verifying" | "error";

export interface AgentStatus {
  phase: AgentPhase;
  message: string;
  versionId?: string;
}

export type ChatRole = "user" | "assistant" | "system" | "tool";

export type ChatMessageKind = "text" | "proposal" | "implementation" | "scan" | "error";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  kind: ChatMessageKind;
  content: string;
  createdAt: string;
  proposalId?: string;
  details?: string;
}

/**
 * Transient token stream rendered under the chat history. It is never persisted:
 * the completed assistant message replaces it once the turn settles.
 */
export interface ChatStream {
  id: string;
  label: string;
  content: string;
  phase: "thinking" | "responding";
  createdAt: string;
  versionId?: string;
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
  /** Scan syncs and imports are graph-only; drift amendments also trigger implementation. */
  architectureOnly: boolean;
}

/** Read-only reconstruction of one WAL version, used by the history replay dialog. */
export interface VersionReplay {
  versionId: string;
  ordinal: number | null;
  status: VersionStatus;
  intent: Intent;
  decision: Decision | null;
  baseSnapshot: ArchSnapshot;
  targetSnapshot: ArchSnapshot;
  diff: ArchDiff;
  baseHash: string;
  targetHash: string;
  diffHash: string;
  /** True when this version's ops were applied to the live architecture fold. */
  applied: boolean;
  warnings: string[];
}

/** Last provider request's context footprint, shown in the chat composer. */
export interface ContextUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  updatedAt: string | null;
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
  metrics: ProjectMetrics;
  context: ContextUsage;
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
  | "command-palette"
  | "about";

export type JinEvent =
  | { type: "state"; state: AppState }
  | { type: "agent"; status: AgentStatus; state: AppState }
  | { type: "stream"; stream: ChatStream | null }
  | { type: "update"; update: UpdateState }
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
  amendArchitecture: "jin:amend-architecture",
  mergeIntent: "jin:merge-intent",
  sendMessage: "jin:send-message",
  approveProposal: "jin:approve-proposal",
  rejectProposal: "jin:reject-proposal",
  retryImplementation: "jin:retry-implementation",
  replayVersion: "jin:replay-version",
  cancelAgent: "jin:cancel-agent",
  getFileTree: "jin:get-file-tree",
  readFile: "jin:read-file",
  openInExternalEditor: "jin:open-in-external-editor",
  getSettings: "jin:get-settings",
  saveSettings: "jin:save-settings",
  getLlmLogPath: "jin:get-llm-log-path",
  openLlmLogFolder: "jin:open-llm-log-folder",
  getTools: "jin:get-tools",
  refreshTools: "jin:refresh-tools",
  searchExtensions: "jin:search-extensions",
  installLspExtension: "jin:install-lsp-extension",
  uninstallLspExtension: "jin:uninstall-lsp-extension",
  searchCode: "jin:search-code",
  listModels: "jin:list-models",
  mcpCall: "jin:mcp-call",
  gitStatus: "jin:git-status",
  gitBranches: "jin:git-branches",
  gitCheckout: "jin:git-checkout",
  gitLog: "jin:git-log",
  gitShow: "jin:git-show",
  gitStage: "jin:git-stage",
  gitUnstage: "jin:git-unstage",
  gitCommit: "jin:git-commit",
  gitPush: "jin:git-push",
  gitPull: "jin:git-pull",
  gitFetch: "jin:git-fetch",
  installMergeDriver: "jin:install-merge-driver",
  mergeInstructions: "jin:merge-instructions",
  getUpdateState: "jin:get-update-state",
  checkForUpdates: "jin:check-for-updates",
  downloadUpdate: "jin:download-update",
  installUpdate: "jin:install-update",
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
  /** Draft an architecture and code repair for a version whose implementation drifted. */
  amendArchitecture(versionId: string): Promise<AppState>;
  /** Draft a merge intent for versions the fold skipped after a Git merge. */
  mergeIntent(): Promise<AppState>;
  sendMessage(text: string): Promise<AppState>;
  approveProposal(id: string, note?: string): Promise<AppState>;
  rejectProposal(id: string, note?: string): Promise<AppState>;
  retryImplementation(versionId?: string): Promise<AppState>;
  /** Read-only reconstruction of one historical version from the WAL. */
  replayVersion(versionId: string): Promise<VersionReplay>;
  cancelAgent(): Promise<void>;
  getFileTree(): Promise<FileNode>;
  readFile(path: string): Promise<FileContent>;
  openInExternalEditor(path: string): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: SettingsPatch): Promise<AppSettings>;
  /** Absolute path of today's LLM diagnostics log file (JSONL). */
  getLlmLogPath(): Promise<string>;
  /** Reveal the LLM diagnostics log folder in the OS file manager. */
  openLlmLogFolder(): Promise<void>;
  getTools(): Promise<ToolsInfo>;
  refreshTools(): Promise<ToolsInfo>;
  searchExtensions(query: string, limit?: number): Promise<MarketplaceSearchResult>;
  installLspExtension(id: string): Promise<LspInstallResult>;
  uninstallLspExtension(id: string): Promise<LspInstallResult>;
  searchCode(query: string, limit?: number): Promise<ReuseCandidate[]>;
  /** Fetch model ids and capability hints from the configured provider. */
  listModels(request: ProviderModelRequest): Promise<ProviderModelCatalog>;
  mcpCall(server: string, tool: string, args?: Record<string, unknown>): Promise<McpCallResult>;
  gitStatus(): Promise<GitStatus>;
  gitBranches(): Promise<GitBranchList>;
  /** Switch branches; remote names create a local tracking branch on first use. */
  gitCheckout(
    name: string,
    create?: boolean,
    dirtyAction?: GitDirtyCheckoutAction,
  ): Promise<GitActionResult>;
  gitLog(limit?: number): Promise<GitCommit[]>;
  gitShow(hash: string): Promise<GitCommitDetail>;
  gitStage(paths?: string[]): Promise<GitActionResult>;
  gitUnstage(paths?: string[]): Promise<GitActionResult>;
  gitCommit(message: string): Promise<GitActionResult>;
  gitPush(): Promise<GitActionResult>;
  gitPull(): Promise<GitActionResult>;
  gitFetch(): Promise<GitActionResult>;
  installMergeDriver(): Promise<{ ok: boolean; message: string }>;
  mergeInstructions(): Promise<string>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  onEvent(listener: (event: JinEvent) => void): () => void;
}

/** Serializable node helper used by the renderer without importing the model. */
export type RendererNodeChange = NodeChange;

/** Re-export a few model types that renderer components use frequently. */
export type { ArchNode, ArchOp, ArchSnapshot, Decision, FoldResult, Intent, VersionStatus };
