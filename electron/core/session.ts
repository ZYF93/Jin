import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ArchDiff, RiskHint } from "../../shared/arch/diff";
import { hasFailedDrift, latestImplementation } from "../../shared/arch/conformance";
import { translate, type MessageKey, type TranslationParams } from "../../shared/i18n";
import { isProviderConfigured } from "../../shared/provider";
import type {
  ArchNode,
  ArchOp,
  ArchSnapshot,
  Actor,
  Decision,
  ImplementationCheck,
  ImplementationRecord,
  Intent,
  IntentTask,
  Touch,
  VersionState,
  WalRecord,
  WalConflict,
} from "../../shared/ledger/types";
import type {
  AgentStatus,
  AppState,
  ChatMessage,
  ChatStream,
  ContextUsage,
  FileContent,
  FileNode,
  JinEvent,
  LspStatus,
  ProjectInfo,
  ProposalView,
  ReuseCandidate,
  ReusePlan,
  ScanStatus,
  ToolsInfo,
  VersionReplay,
  WalInfo,
} from "../../shared/ipc";
import { commitFileTransaction, type StagedFileEdit } from "./agent/file-transaction";
import { reviewProposalAcceptance } from "./agent/acceptance";
import {
  applyIntent,
  applyTouch,
  cloneSnapshot,
  diffHashForChanges,
  emptySnapshot,
  hashSnapshot,
} from "./arch/snapshot";
import { hashValue } from "./hash/canonical";
import { diffSnapshots, riskHints } from "./arch/diff";
import { previewOps } from "./arch/preview";
import { openJinIndex, type JinIndex } from "./db/jin-index";
import { buildFileTree, readProjectFile, resolveProjectFile } from "./files/tree";
import { ulid } from "./ids/ulid";
import { detectLanguageServers } from "./lsp/registry";
import { collectLspFacts } from "./lsp/facts";
import { LspMarketplace } from "./lsp/marketplace";
import { LspStore } from "./lsp/store";
import type { LspFacts } from "./lsp/client";
import { planWithProvider } from "./agent/llm-planner";
import { normalizePlan } from "./agent/normalize-plan";
import type { PlanDraft } from "./agent/plan-types";
import {
  ProviderError,
  type ProviderConfig,
  type ProviderTokenUsage,
  consumeToolsUnsupportedHint,
} from "./agent/provider";
import { readConfig, walPath, cachePath, type JinConfig } from "./project/config";
import { loadWal, appendRecord, appendRecords } from "./wal/io";
import { foldWal } from "./wal/fold";
import { replayVersion as replayWalVersion } from "./wal/replay";
import { FATAL_WAL_CONFLICTS, planMerge } from "./wal/merge-intent";
import { walHeads } from "./wal/heads";
import {
  makeDecisionRecord,
  makeImplementationRecord,
  makeIntentRecord,
  makeOpRecord,
  makeTouchRecord,
  type RecordBase,
} from "./wal/record";
import { HlcClock, formatHlc, parseHlc, type Hlc } from "./time/hlc";
import { RagService, RagStore } from "./rag/rag";
import { evaluateReuse } from "./rag/reuse-guard";
import { UsageLedger, type UsageSource } from "./metrics/usage";
import { computeProjectMetrics } from "./metrics/metrics";
import { normalizeProjectPath, runEkoCoder } from "./agent/eko-runtime";
import {
  implementationScopePaths,
  implementationTaskPaths,
  independentImplementationTasks,
} from "./agent/implementation-scope";
import {
  createImplementationWorkspace,
  disposeImplementationWorkspace,
  assertIntegrationBaselines,
  withProjectWriteLock,
} from "./agent/workspace";
import { applyUnifiedPatchFile, parseUnifiedPatch } from "./agent/patch";
import { SkillManager } from "./skills/manager";
import { McpManager } from "./mcp/manager";
import { diffScanToOps, scanNodeIntents } from "./scan/import";
import { scanProject, listSourceFiles, type ScanResult } from "./scan/scanner";
import { readScanManifest, writeScanManifest } from "./scan/manifest";
import { runSemanticPass } from "./scan/semantic";
import { gitState, runProjectChecks, verifyArchitecture } from "./verify/verify";
import { installMergeDriver, mergeInstructions } from "./git/merge-driver";
import type { SettingsStore } from "./settings/app-settings";

const CHAT_FILE = "chat.json";
const MAX_CHAT_MESSAGES = 240;
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export interface SessionDeps {
  settings: SettingsStore;
  recentProjects: () => import("../../shared/ipc").RecentProject[];
  emit: (event: JinEvent) => void;
  /** Shared app-level VS Code Marketplace store, when available. */
  marketplace?: LspMarketplace;
}

interface InternalProposal {
  id: string;
  intent: Intent;
  ops: ArchOp[];
  touches: Touch[];
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
  opRecordIds?: string[];
  /** Scan syncs and imports are graph-only; drift amendments also trigger implementation. */
  architectureOnly?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/**
 * Pull a human-readable JSON string field out of a partially streamed JSON
 * document. Planner models emit `message` (or `goal`) before the ops array, so
 * the chat can show meaningful prose while the rest of the object is arriving.
 */
export function streamingPreview(raw: string, fields: readonly string[]): string {
  for (const field of fields) {
    const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(raw);
    if (!match) continue;
    let index = match.index + match[0].length;
    let text = "";
    while (index < raw.length) {
      const char = raw[index] as string;
      if (char === '"') break;
      if (char !== "\\") {
        text += char;
        index += 1;
        continue;
      }
      const escape = raw[index + 1];
      if (escape === undefined) break;
      const simple: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (escape in simple) {
        text += simple[escape];
        index += 2;
        continue;
      }
      if (escape === "u") {
        const hex = raw.slice(index + 2, index + 6);
        if (hex.length < 4) break;
        text += String.fromCharCode(Number.parseInt(hex, 16) || 0);
        index += 6;
        continue;
      }
      text += escape;
      index += 2;
    }
    if (text.trim()) return text;
  }
  return "";
}

function latestHlc(records: readonly WalRecord[]): Hlc | null {
  let best: Hlc | null = null;
  for (const record of records) {
    try {
      const hlc = parseHlc(record.hlc);
      if (!best || hlc.wall > best.wall || (hlc.wall === best.wall && hlc.counter > best.counter)) {
        best = hlc;
      }
    } catch {
      // A malformed record is reported by the WAL parser; ignore its clock here.
    }
  }
  return best;
}

function emptyScanStatus(message: string): ScanStatus {
  return {
    phase: "idle",
    files: 0,
    symbols: 0,
    nodes: 0,
    edges: 0,
    message,
    updatedAt: null,
  };
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ChatMessage).id === "string" &&
    typeof (value as ChatMessage).content === "string" &&
    ["user", "assistant", "system", "tool"].includes((value as ChatMessage).role)
  );
}

function emptyAgentStatus(message: string): AgentStatus {
  return { phase: "idle", message };
}

export class ProjectSession {
  readonly root: string;
  readonly config: JinConfig;
  private readonly deps: SessionDeps;
  private readonly index: JinIndex;
  private records: WalRecord[] = [];
  private snapshot: ArchSnapshot = emptySnapshot();
  private conflicts: WalConflict[] = [];
  private warnings: string[] = [];
  private proposal: InternalProposal | null = null;
  private messages: ChatMessage[] = [];
  private scanStatus: ScanStatus;
  private lsp: LspStatus[] = [];
  private readonly lspStore: LspStore;
  private lastLspFacts: LspFacts | null = null;
  private scanResult: ScanResult | null = null;
  private rag: RagService;
  private readonly skills: SkillManager;
  private readonly mcp: McpManager;
  private readonly marketplace: LspMarketplace;
  private readonly usage: UsageLedger;
  private tools: ToolsInfo;
  private agentStatus: AgentStatus;
  private lastContext: ContextUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    model: "",
    updatedAt: null,
  };
  private clock: HlcClock;
  private actor: Actor;
  private watcher: FSWatcher | null = null;
  private sourceWatchers: FSWatcher[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private sourceTimer: NodeJS.Timeout | null = null;
  private factsRefresh: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private stream: ChatStream | null = null;
  private streamTimer: NodeJS.Timeout | null = null;
  private readonly streamId = ulid();
  private closed = false;
  private branch: string | null = null;
  /** Record ids this process just appended; a watcher echo must not look like a pull. */
  private readonly localWrites = new Set<string>();

  constructor(root: string, deps: SessionDeps) {
    this.root = resolve(root);
    this.deps = deps;
    this.scanStatus = this.emptyScanStatus();
    this.agentStatus = this.emptyAgentStatus();
    this.config = readConfig(this.root);
    this.skills = new SkillManager(this.root);
    this.mcp = new McpManager(this.root);
    this.marketplace =
      deps.marketplace ?? new LspMarketplace(join(homedir(), ".config", "jin", "lsp-extensions"));
    this.usage = new UsageLedger(this.root);
    this.actor = this.currentActor();
    const initialHlc = latestHlc([]);
    this.clock = new HlcClock(this.actor.id, initialHlc ?? undefined);
    this.tools = {
      builtin: [
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
      ],
      skills: this.skills.list(),
      mcpServers: this.mcp.list(),
      updatedAt: nowIso(),
    };
    this.branch = this.readGitBranch();
    this.index = openJinIndex(this.root);
    this.rag = new RagService(new RagStore(this.index.db));
    this.lspStore = new LspStore(this.index.db);
    this.loadWalIntoState();
    this.messages = this.loadChat();
    this.lsp = detectLanguageServers([], this.marketplace.specs());
    this.startWatcher();
  }

  private t(key: MessageKey, params?: TranslationParams): string {
    return translate(this.deps.settings.get().language, key, params);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof ProviderError && error.status === 429) {
      return this.t("error.providerRateLimit");
    }
    if (error instanceof ProviderError && error.retryAfterSeconds !== undefined) {
      return this.t("error.providerCircuitOpen", {
        seconds: error.retryAfterSeconds,
      });
    }
    return error instanceof Error ? error.message : String(error);
  }

  private emptyScanStatus(): ScanStatus {
    return emptyScanStatus(this.t("scan.idle"));
  }

  private emptyAgentStatus(): AgentStatus {
    return emptyAgentStatus(this.t("scan.ready"));
  }

  async initialize(): Promise<void> {
    if (this.records.length === 0) {
      if (this.messages.length === 0) {
        this.addMessage(
          "system",
          "text",
          this.t("session.openedEmpty", { name: this.config.project.name }),
        );
      }
      try {
        await this.scan();
      } catch (error) {
        this.addMessage(
          "assistant",
          "error",
          this.t("session.initialScanFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    } else {
      if (this.messages.length === 0) {
        this.addMessage(
          "system",
          "text",
          this.t("session.openedLoaded", {
            name: this.config.project.name,
            records: this.records.length,
            nodes: Object.keys(this.snapshot.nodes).length,
          }),
        );
      }
      this.scanStatus = {
        ...this.scanStatus,
        phase: "scanning",
        message: this.t("scan.refreshing"),
      };
      void this.refreshFacts()
        .then(() => this.resumePendingImplementation())
        .catch((error: unknown) => {
          this.scanStatus = {
            ...this.scanStatus,
            phase: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
          this.emitState();
        });
    }
    this.emitState();
  }

  /**
   * Approval is durable in the WAL. If the process stopped after recording an
   * approval but before the implementation record was appended, resume the
   * newest code version after loading the source context. This does not depend
   * on planner history or the size of its compressed architecture prompt.
   */
  resumePendingImplementation(): void {
    if (!this.scanResult || !this.deps.settings.isAgentConfigured()) return;
    if (this.agentStatus.phase !== "idle" && this.agentStatus.phase !== "error") return;
    const latest = Object.values(this.snapshot.versions).sort(
      (left, right) => (right.ordinal ?? 0) - (left.ordinal ?? 0),
    )[0];
    if (!latest || latest.status !== "approved" || latest.implementations.length > 0) return;
    const intent = this.snapshot.intents[latest.intentId];
    if (!intent || intent.mode === "architecture") return;
    const attemptEnded = this.messages.some(
      (message) =>
        message.proposalId === latest.id &&
        (message.kind === "error" ||
          message.content === translate("en", "session.implementationCancelled") ||
          message.content === translate("zh", "session.implementationCancelled")),
    );
    if (attemptEnded) return;
    this.addMessage(
      "assistant",
      "text",
      this.t("session.resumingImplementation", { title: intent.title }),
      { proposalId: latest.id },
    );
    void this.retryImplementation(latest.id).catch((error: unknown) => {
      this.agentStatus = {
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
        versionId: latest.id,
      };
      this.emitState();
    });
  }

  private currentActor(): Actor {
    const identity = this.deps.settings.get().identity;
    return {
      id: identity.actorId,
      kind: "user",
      name: identity.name || this.t("common.jinUser"),
      ...(identity.email ? { email: identity.email } : {}),
    };
  }

  /** Record provider tokens against the prices configured at call time. */
  private recordUsage(source: UsageSource, model: string, usage: ProviderTokenUsage): void {
    const provider = this.deps.settings.get().provider;
    this.usage.record(source, model, usage, {
      inputPerMillion: provider.inputPricePerMillion ?? 0,
      outputPerMillion: provider.outputPricePerMillion ?? 0,
    });
    this.lastContext = {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.promptTokens + usage.completionTokens,
      model,
      updatedAt: nowIso(),
    };
  }

  private readGitBranch(): string | null {
    try {
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }

  private loadWalIntoState(): void {
    const loaded = loadWal(walPath(this.root));
    if (loaded.errors.length > 0) {
      this.warnings = loaded.errors.map((error) =>
        this.t("scan.walLine", { line: error.line, message: error.message }),
      );
      this.scanStatus = {
        ...this.scanStatus,
        phase: "failed",
        message: this.t("scan.walParseErrors"),
      };
      return;
    }
    const folded = foldWal(loaded.records);
    this.records = loaded.records;
    this.snapshot = folded.snapshot;
    this.conflicts = folded.conflicts;
    this.warnings = folded.warnings;
    const max = latestHlc(loaded.records);
    if (max) this.clock.receive(max);
    try {
      this.index.rebuild(loaded.records);
    } catch (error) {
      this.warnings = [
        ...this.warnings,
        this.t("scan.indexRebuild", {
          message: error instanceof Error ? error.message : String(error),
        }),
      ];
    }
  }

  private refreshFromWal(announce = false): boolean {
    const previous = this.records;
    const previousIds = new Set(previous.map((record) => record.id));
    const loaded = loadWal(walPath(this.root));
    if (loaded.errors.length > 0) {
      this.warnings = loaded.errors.map((error) =>
        this.t("scan.walLine", { line: error.line, message: error.message }),
      );
      this.emitState();
      return false;
    }
    const folded = foldWal(loaded.records);
    this.records = loaded.records;
    this.snapshot = folded.snapshot;
    this.conflicts = folded.conflicts;
    this.warnings = folded.warnings;
    const max = latestHlc(loaded.records);
    if (max) this.clock.receive(max);
    try {
      this.index.rebuild(loaded.records);
    } catch (error) {
      this.warnings = [
        ...this.warnings,
        this.t("scan.indexRebuild", {
          message: error instanceof Error ? error.message : String(error),
        }),
      ];
    }
    if (
      this.proposal?.status === "in_review" &&
      hashSnapshot(this.snapshot) !== this.proposal.baseHash
    ) {
      this.proposal.status = "stale";
    }
    if (announce && previous.length > 0 && !this.closed) {
      const incoming = loaded.records.filter(
        (record) => !previousIds.has(record.id) && !this.localWrites.has(record.id),
      );
      if (incoming.length > 0) {
        const versionIds = [...new Set(incoming.map((record) => record.versionId))];
        const labels = versionIds.slice(0, 6).map((versionId) => {
          const version = this.snapshot.versions[versionId];
          if (!version) return versionId.slice(0, 8);
          return `v${version.ordinal ?? "?"} ${this.t(`status.${version.status}` as MessageKey)}`;
        });
        const more =
          versionIds.length > labels.length
            ? this.t("session.pulledMore", { count: versionIds.length - labels.length })
            : "";
        const open = this.openConflicts();
        const conflictText =
          open.length > 0
            ? this.t("session.pulledConflicts", { count: open.length })
            : this.t("session.pulledReplay");
        this.addMessage(
          "system",
          "scan",
          this.t(incoming.length === 1 ? "session.pulled" : "session.pulledPlural", {
            records: incoming.length,
            labels: labels.join(", ") + more,
            conflictText,
          }),
        );
      }
    }
    this.localWrites.clear();
    return true;
  }

  private startWatcher(): void {
    try {
      this.watcher = watch(join(this.root, ".jin"), { persistent: false }, (_event, filename) => {
        const name = String(filename ?? "");
        if (name !== "wal.jsonl" && name !== "config.yaml") return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = null;
          if (this.closed) return;
          if (name === "config.yaml") {
            this.emitState();
            return;
          }
          if (this.refreshFromWal(true)) this.emitState();
        }, 180);
      });
    } catch {
      this.watcher = null;
    }
    this.startSourceWatcher();
  }

  /**
   * Watch source roots so LSP facts and the reuse index stay warm between
   * explicit scans. This never writes a WAL proposal by itself; architecture
   * changes still require an Intent and one approval.
   */
  private startSourceWatcher(): void {
    for (const scanRoot of this.config.scan.roots) {
      const absolute = resolve(this.root, scanRoot);
      if (!existsSync(absolute)) continue;
      try {
        const watcher = watch(
          absolute,
          { recursive: true, persistent: false },
          (_event, filename) => {
            const name = String(filename ?? "");
            if (!name) return;
            const parts = name.split(/[\\/]/);
            if (
              parts.some((part) =>
                [".git", ".jin", "node_modules", "dist", "dist-electron", "release"].includes(part),
              )
            ) {
              return;
            }
            this.queueFactsRefresh();
          },
        );
        this.sourceWatchers.push(watcher);
      } catch {
        // Recursive watch is platform-dependent; explicit Scan still works.
      }
    }
  }

  private queueFactsRefresh(): void {
    if (this.sourceTimer) clearTimeout(this.sourceTimer);
    this.sourceTimer = setTimeout(() => {
      this.sourceTimer = null;
      if (this.closed || this.factsRefresh) return;
      if (
        this.agentStatus.phase === "planning" ||
        this.agentStatus.phase === "implementing" ||
        this.agentStatus.phase === "verifying"
      ) {
        return;
      }
      this.factsRefresh = this.refreshFacts()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.scanStatus = {
            ...this.scanStatus,
            phase: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
          this.emitState();
        })
        .finally(() => {
          this.factsRefresh = null;
        });
    }, 500);
  }

  private chatPath(): string {
    return join(cachePath(this.root), CHAT_FILE);
  }

  private loadChat(): ChatMessage[] {
    try {
      const text = readFileSync(this.chatPath(), "utf8");
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isChatMessage).slice(-MAX_CHAT_MESSAGES);
    } catch {
      return [];
    }
  }

  private persistChat(): void {
    try {
      mkdirSync(cachePath(this.root), { recursive: true });
      const path = this.chatPath();
      const temp = `${path}.${process.pid}.${ulid()}.tmp`;
      writeFileSync(temp, JSON.stringify(this.messages, null, 2), "utf8");
      renameSync(temp, path);
    } catch {
      // Chat history is a convenience cache, not the architecture ledger.
    }
  }

  private addMessage(
    role: ChatMessage["role"],
    kind: ChatMessage["kind"],
    content: string,
    extra: Pick<ChatMessage, "proposalId" | "details"> = {},
  ): ChatMessage {
    const message: ChatMessage = {
      id: ulid(),
      role,
      kind,
      content,
      createdAt: nowIso(),
      ...extra,
    };
    this.messages.push(message);
    if (this.messages.length > MAX_CHAT_MESSAGES) {
      this.messages = this.messages.slice(-MAX_CHAT_MESSAGES);
    }
    this.persistChat();
    return message;
  }

  private emitState(): void {
    this.deps.emit({ type: "state", state: this.getState() });
  }

  private startStream(label: string, versionId?: string): void {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    this.stream = {
      id: this.streamId,
      label,
      content: "",
      phase: "thinking",
      createdAt: nowIso(),
      ...(versionId ? { versionId } : {}),
    };
    this.emitStream();
  }

  /** Replace the transient stream text. Provider deltas are accumulated by callers. */
  private updateStream(
    content: string,
    options: { label?: string; phase?: ChatStream["phase"] } = {},
  ): void {
    if (!this.stream) return;
    this.stream = {
      ...this.stream,
      content: content.length > 12_000 ? content.slice(-12_000) : content,
      label: options.label ?? this.stream.label,
      phase: options.phase ?? this.stream.phase,
    };
    if (!this.streamTimer) {
      this.streamTimer = setTimeout(() => {
        this.streamTimer = null;
        this.emitStream();
      }, 45);
      this.streamTimer.unref?.();
    }
  }

  private emitStream(): void {
    this.deps.emit({ type: "stream", stream: this.stream });
  }

  private finishStream(): void {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    if (!this.stream) return;
    this.stream = null;
    this.emitStream();
  }

  private proposalStatus(): ProposalView["status"] {
    const proposal = this.proposal;
    if (!proposal) return "approved";
    if (proposal.status === "in_review" && hashSnapshot(this.snapshot) !== proposal.baseHash) {
      proposal.status = "stale";
    }
    return proposal.status;
  }

  private proposalView(): ProposalView | null {
    if (!this.proposal) return null;
    return {
      id: this.proposal.id,
      intent: this.proposal.intent,
      ops: this.proposal.ops,
      touches: this.proposal.touches,
      baseSnapshot: this.proposal.baseSnapshot,
      targetSnapshot: this.proposal.targetSnapshot,
      baseHash: this.proposal.baseHash,
      targetHash: this.proposal.targetHash,
      diffHash: this.proposal.diffHash,
      diff: this.proposal.diff,
      risks: this.proposal.risks,
      reusePlan: this.proposal.reusePlan,
      createdAt: this.proposal.createdAt,
      status: this.proposalStatus(),
      architectureOnly: Boolean(
        this.proposal.architectureOnly || this.proposal.intent.mode === "architecture",
      ),
    };
  }

  private scanStatusSummary(scan: ScanResult, lspFacts: LspFacts | null = null): string {
    const warnings = scan.warnings.slice(0, 3).join(" ");
    const base = warnings
      ? this.t("scan.summaryWarnings", {
          files: scan.stats.files,
          nodes: scan.stats.nodes,
          warnings,
        })
      : this.t("scan.summary", {
          files: scan.stats.files,
          symbols: scan.stats.symbols,
          nodes: scan.stats.nodes,
        });
    if (!lspFacts || lspFacts.servers.length === 0) return base;
    const lsp = lspFacts.servers
      .map((server) =>
        server.error
          ? this.t("scan.lspServerError", { id: server.id, error: server.error })
          : this.t("scan.lspServer", {
              id: server.id,
              symbols: server.symbols,
              diagnostics: server.diagnostics,
            }),
      )
      .join("; ");
    return this.t("scan.lsp", { base, servers: lsp });
  }

  private async refreshFacts(signal?: AbortSignal): Promise<ScanResult> {
    this.scanStatus = {
      ...this.scanStatus,
      phase: "scanning",
      message: this.t("scan.scanning"),
    };
    this.emitState();
    const listing = listSourceFiles(this.root, this.config, { signal });
    const specs = this.marketplace.specs();
    this.lsp = detectLanguageServers(listing.files, specs);
    let lspFacts: LspFacts | null = null;
    if (!signal?.aborted && this.lsp.some((status) => status.status === "available")) {
      try {
        lspFacts = await collectLspFacts(this.root, listing.files, this.lsp, {
          signal,
          maxFilesPerServer: 60,
          timeoutMs: 9000,
          specs,
        });
      } catch (error) {
        lspFacts = {
          symbols: [],
          diagnostics: [],
          servers: [],
          collectedAt: new Date().toISOString(),
        };
        this.scanStatus = {
          ...this.scanStatus,
          message: this.t("scan.lspUnavailable", {
            message: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }
    this.lastLspFacts = lspFacts;
    const lspByPath = new Map<
      string,
      Array<{
        name: string;
        kind: "method" | "field" | "property";
        line?: number;
        character?: number;
      }>
    >();
    for (const symbol of lspFacts?.symbols ?? []) {
      const list = lspByPath.get(symbol.path);
      const fact = {
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        character: symbol.character,
      };
      if (list) list.push(fact);
      else lspByPath.set(symbol.path, [fact]);
    }
    const scan = scanProject(this.root, this.config, {
      signal,
      lspFacts: lspByPath,
      manifest: readScanManifest(cachePath(this.root)),
    });
    this.scanResult = scan;
    this.rag.update(this.root, scan, this.snapshot);
    try {
      writeScanManifest(cachePath(this.root), scan.manifest);
    } catch (error) {
      scan.warnings.push(
        this.t("scan.manifestWrite", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (lspFacts) {
      try {
        this.lspStore.replaceAll(lspFacts);
      } catch (error) {
        scan.warnings.push(
          this.t("scan.lspCacheWrite", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    this.scanStatus = {
      phase: "ready",
      files: scan.stats.files,
      symbols: scan.stats.symbols,
      nodes: scan.stats.nodes,
      edges: scan.stats.edges,
      message: this.scanStatusSummary(scan, lspFacts),
      updatedAt: scan.scannedAt,
    };
    this.emitState();
    return scan;
  }

  private applyTouchColors(diff: ArchDiff, touches: readonly Touch[], target: ArchSnapshot): void {
    const color = (startId: string): void => {
      let node: ArchNode | undefined = target.nodes[startId];
      const seen = new Set<string>();
      while (node && !seen.has(node.id)) {
        seen.add(node.id);
        if (!diff.colors[node.id]) diff.colors[node.id] = "modified";
        node = node.parentId ? target.nodes[node.parentId] : undefined;
      }
    };
    for (const touch of touches) color(touch.facetId ?? touch.nodeId);
    diff.summary.affected = Object.keys(diff.colors).length;
  }

  private makeProposal(
    intent: Intent,
    ops: ArchOp[],
    touches: Touch[],
    reusePlan: ReusePlan | null,
  ): InternalProposal {
    const base = cloneSnapshot(this.snapshot);
    const preview = previewOps(base, ops, intent.versionId);
    if (preview.conflicts.length > 0) {
      throw new Error(
        this.t("error.proposalConflicts", { conflicts: preview.conflicts.join("; ") }),
      );
    }
    const target = preview.snapshot;
    const intentConflicts = applyIntent(target, intent);
    if (intentConflicts.length > 0) {
      throw new Error(
        this.t("error.intentTargetsMissing", {
          conflicts: intentConflicts.map((item) => item.message).join("; "),
        }),
      );
    }
    for (const touch of touches) {
      const conflict = applyTouch(target, touch);
      if (conflict) throw new Error(conflict.message);
    }
    const baseHash = hashSnapshot(base);
    const targetHash = hashSnapshot(target);
    const diffHash = diffHashForChanges(intent, ops, touches);
    const diff = diffSnapshots(base, target);
    this.applyTouchColors(diff, touches, target);
    const risks = riskHints(base, target, diff);
    return {
      id: intent.versionId,
      intent,
      ops,
      touches,
      baseSnapshot: base,
      targetSnapshot: target,
      baseHash,
      targetHash,
      diffHash,
      diff,
      risks,
      reusePlan,
      createdAt: nowIso(),
      status: "in_review",
    };
  }

  private makeIntent(
    plan: PlanDraft,
    versionId: string,
    nodeIntents: Intent["nodeIntents"],
  ): Intent {
    const taskIds = new Map(plan.tasks.map((task) => [task.title, ulid()]));
    const tasks: IntentTask[] = plan.tasks.length
      ? plan.tasks.map((task) => ({
          id: taskIds.get(task.title) ?? ulid(),
          title: task.title,
          status: "pending",
          dependsOn: (task.dependsOn ?? []).map(
            (dependency) => taskIds.get(dependency) ?? dependency,
          ),
          acceptance: task.acceptance,
          files: task.files,
        }))
      : [
          {
            id: ulid(),
            title: plan.title,
            status: "pending",
            dependsOn: [],
            acceptance: [this.t("session.taskAcceptance")],
          },
        ];
    return {
      id: ulid(),
      versionId,
      title: plan.title,
      goal: plan.goal,
      tasks,
      nodeIntents,
      author: this.currentActor(),
      createdAt: nowIso(),
    };
  }

  private touchesForIntent(
    nodeIntents: Intent["nodeIntents"],
    ops: readonly ArchOp[],
    intent: Intent,
  ): Touch[] {
    const structural = new Set<string>();
    for (const op of ops) {
      if (op.op === "node.add") structural.add(op.node.id);
      else if (op.op === "node.update" || op.op === "node.remove") structural.add(op.id);
    }
    const touches: Touch[] = [];
    const seen = new Set<string>();
    for (const nodeIntent of nodeIntents) {
      const targetId = nodeIntent.facetId ?? nodeIntent.nodeId;
      if (structural.has(targetId) || seen.has(targetId)) continue;
      const target = this.snapshot.nodes[targetId];
      if (!target) continue;
      const nodeId = nodeIntent.facetId
        ? (this.snapshot.nodes[nodeIntent.facetId]?.parentId ?? nodeIntent.nodeId)
        : nodeIntent.nodeId;
      if (!this.snapshot.nodes[nodeId]) continue;
      seen.add(targetId);
      touches.push({
        id: ulid(),
        versionId: intent.versionId,
        intentId: intent.id,
        nodeId,
        facetId: nodeIntent.facetId ?? null,
        reason: nodeIntent.statement,
        codeRefs: target.file ? [target.file] : target.path ? [target.path] : [],
        tests: [],
        actor: this.currentActor(),
        createdAt: nowIso(),
      });
    }
    return touches;
  }

  private languageCheck(): ImplementationCheck | null {
    const facts = this.lastLspFacts;
    if (!facts || facts.servers.length === 0) return null;
    const name = this.t("session.languageDiagnostics");
    const failed = facts.servers.filter((server) => server.error);
    if (failed.length === facts.servers.length) {
      return {
        name,
        status: "skip",
        detail: failed.map((server) => `${server.id}: ${server.error ?? "unavailable"}`).join("; "),
      };
    }
    const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      return {
        name,
        status: "fail",
        detail: this.t("session.diagnosticsErrors", {
          count: errors.length,
          details: errors
            .slice(0, 4)
            .map((diagnostic) => `${diagnostic.path}:${diagnostic.line} ${diagnostic.message}`)
            .join("; "),
        }),
      };
    }
    const totals = facts.servers
      .filter((server) => !server.error)
      .map((server) => `${server.id}: ${server.symbols} symbols`)
      .join("; ");
    return {
      name,
      status: "pass",
      detail: totals || this.t("session.noDiagnosticErrors"),
    };
  }

  private async ensureScan(signal?: AbortSignal): Promise<ScanResult> {
    if (this.scanResult) return this.scanResult;
    return this.refreshFacts(signal);
  }

  /**
   * A drift amendment is only meaningful for a version whose latest
   * implementation actually failed the drift check. Test/lint failures and op
   * conformance failures are fixed in code, not by editing architecture.
   */
  private requireAmendmentTarget(versionId: string): {
    version: VersionState;
    implementation: ImplementationRecord;
    intent: Intent;
  } {
    const version = this.snapshot.versions[versionId];
    if (!version) throw new Error(this.t("error.unknownVersion", { id: versionId }));
    if (version.status !== "implemented") {
      throw new Error(this.t("error.amendOnlyImplemented"));
    }
    const implementation = latestImplementation(this.snapshot, version);
    if (!implementation || !hasFailedDrift(implementation)) {
      throw new Error(this.t("error.noDriftToAmend"));
    }
    const intent = this.snapshot.intents[version.intentId];
    if (!intent) throw new Error(this.t("error.versionNoIntent"));
    return { version, implementation, intent };
  }

  async sendMessage(text: string): Promise<AppState> {
    const request = text.trim();
    if (!request) return this.getState();
    if (this.proposal?.status === "in_review") {
      throw new Error(this.t("error.approveOrRejectFirst"));
    }
    if (
      this.agentStatus.phase === "planning" ||
      this.agentStatus.phase === "implementing" ||
      this.agentStatus.phase === "verifying"
    ) {
      throw new Error(this.t("error.agentWorking"));
    }
    const provider = this.deps.settings.providerConfig();
    if (!isProviderConfigured(provider)) {
      throw new Error(this.t("error.providerRequired"));
    }
    const history = this.messages
      .slice(-12)
      .filter((message) => message.kind === "text" || message.kind === "proposal")
      .map((message) => ({
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        content: message.content.slice(0, 6000),
      }));
    this.addMessage("user", "text", request);
    this.agentStatus = { phase: "planning", message: this.t("session.planning") };
    this.deps.emit({ type: "agent", status: this.agentStatus, state: this.getState() });
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    try {
      await this.ensureScan(signal);
      const reusePlan = this.rag.plan(request);
      let plan: PlanDraft;
      this.startStream(this.t("chat.streamPlanning"));
      let raw = "";
      try {
        plan = await planWithProvider(provider as ProviderConfig, request, {
          snapshot: this.snapshot,
          skills: this.skills.promptFor(request),
          reuseSummary:
            reusePlan.summary +
            "\n" +
            reusePlan.candidates
              .slice(0, 5)
              .map((candidate) => `- ${candidate.path}: ${candidate.reason}`)
              .join("\n"),
          history,
          signal,
          onUsage: (usage) => this.recordUsage("plan", provider.model, usage),
          onDelta: (delta) => {
            if (signal.aborted) return;
            raw += delta;
            const preview = streamingPreview(raw, ["message", "goal"]);
            if (preview) {
              this.updateStream(preview, {
                label: this.t("chat.streamPlanning"),
                phase: "responding",
              });
            }
          },
        });
      } catch (error) {
        if (signal.aborted) {
          // Cancelling a turn must not fabricate a fallback proposal.
          this.finishStream();
          this.agentStatus = this.emptyAgentStatus();
          this.emitState();
          return this.getState();
        }
        throw error;
      }
      if (plan.kind === "chat") {
        this.finishStream();
        this.addMessage("assistant", "text", plan.assistantMessage);
        this.agentStatus = this.emptyAgentStatus();
        this.emitState();
        return this.getState();
      }
      const versionId = ulid();
      const normalized = normalizePlan(plan, this.snapshot, versionId);
      const intent = this.makeIntent(plan, versionId, normalized.nodeIntents);
      const touches = this.touchesForIntent(normalized.nodeIntents, normalized.ops, intent);
      const proposal = this.makeProposal(intent, normalized.ops, touches, reusePlan);
      this.proposal = proposal;
      this.finishStream();
      const notes = [...normalized.warnings];
      const reuseText =
        reusePlan.candidates.length > 0
          ? this.t("session.reuseFound", {
              paths: reusePlan.candidates
                .slice(0, 3)
                .map((candidate) => candidate.path)
                .join(", "),
            })
          : this.t("session.reuseNoMatch");
      this.addMessage(
        "assistant",
        "proposal",
        `${plan.assistantMessage}\n\n${reuseText}${notes.length ? `\n\n${this.t("session.notes", { notes: notes.join(" ") })}` : ""}`,
        { proposalId: proposal.id },
      );
      this.agentStatus = this.emptyAgentStatus();
      this.emitState();
      return this.getState();
    } catch (error) {
      const message = this.errorMessage(error);
      this.agentStatus = {
        phase: "error",
        message,
      };
      this.addMessage(
        "assistant",
        "error",
        this.t("session.proposalFailed", {
          message,
        }),
        {
          details: error instanceof ProviderError ? error.details : undefined,
        },
      );
      this.emitState();
      return this.getState();
    } finally {
      this.finishStream();
      this.abortController = null;
    }
  }

  async scan(options: { amendmentOf?: string } = {}): Promise<AppState> {
    if (this.proposal?.status === "in_review") {
      throw new Error(this.t("error.rescanBlocked"));
    }
    const amendment = options.amendmentOf ? this.requireAmendmentTarget(options.amendmentOf) : null;
    this.scanStatus = {
      ...this.scanStatus,
      phase: "scanning",
      message: this.t("scan.scanning"),
    };
    this.emitState();
    this.abortController = new AbortController();
    try {
      let scan = await this.refreshFacts(this.abortController.signal);
      let semanticSummary = "";
      const settings = this.deps.settings.get();
      const provider = this.deps.settings.providerConfig();
      const initialImport = !Object.values(this.snapshot.nodes).some((node) => node.level === "L1");
      if ((settings.agent.semanticScan || initialImport) && isProviderConfigured(provider)) {
        this.scanStatus = {
          ...this.scanStatus,
          message: this.t("scan.refining"),
        };
        this.emitState();
        const semantic = await runSemanticPass(scan, provider as ProviderConfig, {
          signal: this.abortController.signal,
          temperature: settings.agent.temperature,
          maxTokens: Math.min(settings.agent.maxTokens, 6000),
          onUsage: (usage) => this.recordUsage("semantic", provider.model, usage),
        });
        scan = semantic.scan;
        if (semantic.warnings.length > 0) scan.warnings.push(...semantic.warnings);
        if (semantic.summary) {
          semanticSummary = semantic.summary;
          this.rag.update(this.root, scan, this.snapshot);
        }
        this.scanResult = scan;
        this.scanStatus = {
          ...this.scanStatus,
          phase: "ready",
          files: scan.stats.files,
          symbols: scan.stats.symbols,
          nodes: scan.stats.nodes,
          edges: scan.stats.edges,
          message: this.scanStatusSummary(scan),
          updatedAt: scan.scannedAt,
        };
        this.emitState();
      }
      const importResult = diffScanToOps(this.snapshot, scan);
      if (importResult.ops.length === 0) {
        const summary = `${this.scanStatusSummary(scan)}${
          semanticSummary ? ` ${semanticSummary}` : ""
        }`;
        this.addMessage(
          "assistant",
          "scan",
          amendment
            ? this.t("session.noDrift", {
                ordinal: `v${amendment.version.ordinal ?? "?"}`,
                summary,
              })
            : this.t("session.inSync", { summary }),
        );
        this.scanStatus = { ...this.scanStatus, phase: "ready" };
        this.emitState();
        return this.getState();
      }
      const empty = initialImport;
      const versionId = ulid();
      const ordinal = amendment ? `v${amendment.version.ordinal ?? "?"}` : "";
      const title = amendment
        ? this.t("session.syncTitle.amendment", { ordinal })
        : empty
          ? this.t("session.syncTitle.import")
          : this.t("session.syncTitle.sync");
      const goal = amendment
        ? this.t("session.syncGoal.amendment", {
            title: amendment.intent.title,
            added: importResult.addedNodes,
            updated: importResult.updatedNodes,
            removed: importResult.removedNodes,
          })
        : empty
          ? this.t("session.syncGoal.import", { files: scan.stats.files })
          : this.t("session.syncGoal.sync", {
              files: scan.stats.files,
              added: importResult.addedNodes,
              updated: importResult.updatedNodes,
              removed: importResult.removedNodes,
            });
      const intent: Intent = {
        id: ulid(),
        versionId,
        title,
        goal,
        tasks: [
          {
            id: ulid(),
            title: amendment
              ? this.t("session.syncTask.amendment")
              : empty
                ? this.t("session.syncTask.import")
                : this.t("session.syncTask.sync"),
            status: "pending",
            dependsOn: [],
            acceptance: amendment
              ? [
                  this.t("session.syncAcceptance.amendment.1"),
                  this.t("session.syncAcceptance.amendment.2"),
                  this.t("session.syncAcceptance.amendment.3"),
                ]
              : [
                  this.t("session.syncAcceptance.import.1"),
                  this.t("session.syncAcceptance.import.2"),
                  this.t("session.syncAcceptance.import.3"),
                ],
          },
        ],
        nodeIntents: scanNodeIntents(scan.nodes),
        author: this.currentActor(),
        createdAt: nowIso(),
        mode: amendment ? "code" : "architecture",
      };
      const proposal = this.makeProposal(intent, importResult.ops, [], null);
      if (!amendment) proposal.architectureOnly = true;
      this.proposal = proposal;
      const summary = `${this.scanStatusSummary(scan)}${
        semanticSummary ? ` ${semanticSummary}` : ""
      }`;
      this.addMessage(
        "assistant",
        amendment ? "proposal" : "scan",
        amendment
          ? this.t("session.amendmentReady", {
              ordinal,
              added: importResult.addedNodes,
              updated: importResult.updatedNodes,
              removed: importResult.removedNodes,
              summary,
            })
          : this.t("session.importReady", {
              kind: empty ? this.t("session.importKindInitial") : this.t("session.importKindSync"),
              added: importResult.addedNodes,
              updated: importResult.updatedNodes,
              removed: importResult.removedNodes,
              summary,
            }),
        { proposalId: proposal.id },
      );
      this.emitState();
      return this.getState();
    } catch (error) {
      this.scanStatus = {
        ...this.scanStatus,
        phase: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
      this.addMessage(
        "assistant",
        "error",
        this.t("session.scanFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      this.emitState();
      return this.getState();
    } finally {
      this.abortController = null;
    }
  }

  async amendArchitecture(versionId: string): Promise<AppState> {
    return this.scan({ amendmentOf: versionId });
  }

  /**
   * Conflicts whose version has a later approved merge intent are still part of
   * the ledger's history, but they are no longer open work.
   */
  private openConflicts(): WalConflict[] {
    if (this.conflicts.length === 0) return [];
    const resolved = new Set<string>();
    for (const version of Object.values(this.snapshot.versions)) {
      if (!["approved", "implemented", "verified"].includes(version.status)) continue;
      const intent = this.snapshot.intents[version.intentId];
      for (const id of intent?.resolves ?? []) resolved.add(id);
    }
    if (resolved.size === 0) return this.conflicts;
    return this.conflicts.filter(
      (conflict) => !conflict.versionId || !resolved.has(conflict.versionId),
    );
  }

  /**
   * Draft a merge intent for versions the fold had to skip after a Git merge.
   * The proposal is a three-way merge of each branch's own base and target, so
   * one branch's target never silently reverts the other branch's changes.
   */
  async mergeIntent(): Promise<AppState> {
    if (this.proposal?.status === "in_review") {
      throw new Error(this.t("error.mergeWhileReviewing"));
    }
    const conflicts = this.openConflicts();
    if (conflicts.length === 0) {
      throw new Error(this.t("error.noMergeConflicts"));
    }
    if (conflicts.some((conflict) => FATAL_WAL_CONFLICTS.has(conflict.code))) {
      throw new Error(this.t("error.fatalMergeConflicts"));
    }
    const conflicted = Object.values(this.snapshot.versions)
      .filter((version) => version.status === "conflicted")
      .sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0));
    if (conflicted.length === 0) {
      throw new Error(this.t("error.noConflictedVersion"));
    }
    const sources = conflicted.map((version) => {
      const replay = replayWalVersion(this.records, version.id);
      return {
        versionId: version.id,
        base: replay.baseSnapshot,
        target: replay.targetSnapshot,
      };
    });
    const plan = planMerge(this.snapshot, sources);
    const versionId = ulid();
    const labels = conflicted.map((version) => `v${version.ordinal ?? "?"}`).join(", ");
    const intent: Intent = {
      id: ulid(),
      versionId,
      title: this.t("session.mergeTitle", { labels }),
      goal: this.t("session.mergeGoal", { count: conflicted.length }),
      tasks: [
        {
          id: ulid(),
          title: this.t("session.mergeTask"),
          status: "pending",
          dependsOn: [],
          acceptance: [
            this.t("session.mergeAcceptance.1"),
            this.t("session.mergeAcceptance.2"),
            this.t("session.mergeAcceptance.3"),
          ],
        },
      ],
      nodeIntents: [],
      author: this.currentActor(),
      createdAt: nowIso(),
      mode: "architecture",
      resolves: conflicted.map((version) => version.id),
    };
    const proposal = this.makeProposal(intent, plan.ops, [], null);
    proposal.architectureOnly = true;
    plan.notes.forEach((note, index) => {
      proposal.risks.push({
        id: `risk:merge:${index}`,
        level: "medium",
        title: this.t("session.mergeRiskTitle"),
        detail: note,
      });
    });
    this.proposal = proposal;
    this.addMessage(
      "assistant",
      "proposal",
      this.t("session.mergeMessage", {
        count: plan.ops.length,
        labels,
        ops: plan.ops.length,
        collisions: this.t("session.mergeCollisions", { count: plan.notes.length }),
      }),
      { proposalId: proposal.id },
    );
    this.emitState();
    return this.getState();
  }

  private recordBase(versionId: string, parents: readonly string[]): RecordBase {
    return {
      id: ulid(),
      versionId,
      actor: this.currentActor(),
      hlc: formatHlc(this.clock.now()),
      parents: [...parents],
    };
  }

  private signature(versionId: string, diffHash: string, createdAt: string): string {
    return hashValue({
      versionId,
      diffHash,
      actor: this.currentActor().id,
      createdAt,
    });
  }

  private appendBundle(
    proposal: InternalProposal,
    decision: "approved" | "rejected",
    note: string,
  ): void {
    const versionId = proposal.id;
    const heads = walHeads(this.records);
    const intentRecord = makeIntentRecord(this.recordBase(versionId, heads), proposal.intent);
    let parents = [intentRecord.id];
    const opRecords = proposal.ops.map((op) => {
      const record = makeOpRecord(this.recordBase(versionId, parents), op);
      parents = [record.id];
      return record;
    });
    const touchRecords = proposal.touches.map((touch) => {
      const record = makeTouchRecord(this.recordBase(versionId, parents), touch);
      parents = [record.id];
      return record;
    });
    const createdAt = nowIso();
    const decisionPayload: Decision = {
      id: ulid(),
      versionId,
      decision,
      by: this.currentActor(),
      note,
      baseHash: proposal.baseHash,
      targetHash: proposal.targetHash,
      diffHash: proposal.diffHash,
      signature: this.signature(versionId, proposal.diffHash, createdAt),
      createdAt,
    };
    const decisionRecord = makeDecisionRecord(this.recordBase(versionId, parents), decisionPayload);
    const records: WalRecord[] = [intentRecord, ...opRecords, ...touchRecords, decisionRecord];
    // One fsync for the whole bundle instead of one per op. A 2,000-node import
    // otherwise blocks the main process for tens of seconds.
    appendRecords(walPath(this.root), records);
    for (const record of records) this.localWrites.add(record.id);
    proposal.opRecordIds = opRecords.map((record) => record.id);
    this.refreshFromWal();
  }

  async approveProposal(id: string, note = ""): Promise<AppState> {
    const proposal = this.proposal;
    if (!proposal || proposal.id !== id) throw new Error(this.t("error.noMatchingProposal"));
    if (proposal.status !== "in_review") throw new Error(this.t("error.proposalNotInReview"));
    if (hashSnapshot(this.snapshot) !== proposal.baseHash) {
      proposal.status = "stale";
      this.emitState();
      throw new Error(this.t("error.architectureChanged"));
    }
    const preview = previewOps(this.snapshot, proposal.ops, proposal.id);
    if (preview.conflicts.length > 0) {
      proposal.status = "stale";
      this.emitState();
      throw new Error(this.t("error.staleProposal", { conflicts: preview.conflicts.join("; ") }));
    }
    const target = preview.snapshot;
    const intentConflicts = applyIntent(target, proposal.intent);
    if (intentConflicts.length > 0) {
      throw new Error(intentConflicts[0]?.message ?? this.t("error.intentTargetMissing"));
    }
    for (const touch of proposal.touches) {
      const conflict = applyTouch(target, touch);
      if (conflict) throw new Error(conflict.message);
    }
    if (hashSnapshot(target) !== proposal.targetHash) {
      proposal.status = "stale";
      this.emitState();
      throw new Error(this.t("error.targetChanged"));
    }
    if (diffHashForChanges(proposal.intent, proposal.ops, proposal.touches) !== proposal.diffHash) {
      throw new Error(this.t("error.diffHashMismatch"));
    }
    try {
      this.appendBundle(proposal, "approved", note);
    } catch (error) {
      this.addMessage(
        "assistant",
        "error",
        this.t("session.approvalIncomplete", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      this.emitState();
      throw error;
    }
    proposal.status = "approved";
    const version = this.snapshot.versions[proposal.id];
    const ordinal = version?.ordinal ?? "?";
    if (proposal.architectureOnly) {
      this.addMessage("assistant", "text", this.t("session.approvedArchitecture", { ordinal }), {
        proposalId: proposal.id,
      });
    } else {
      this.addMessage(
        "assistant",
        "text",
        this.t("session.approvedVersion", {
          ordinal,
          next: this.deps.settings.isAgentConfigured()
            ? this.t("session.startingImplementation")
            : this.t("session.implementationPaused"),
        }),
        { proposalId: proposal.id },
      );
    }
    this.emitState();
    if (!proposal.architectureOnly && this.deps.settings.isAgentConfigured()) {
      void this.implementVersion(proposal);
    }
    return this.getState();
  }

  async rejectProposal(id: string, note = ""): Promise<AppState> {
    const proposal = this.proposal;
    if (!proposal || proposal.id !== id) throw new Error(this.t("error.noMatchingProposal"));
    if (proposal.status !== "in_review" && proposal.status !== "stale") {
      throw new Error(this.t("error.proposalNotRejectable"));
    }
    this.appendBundle(proposal, "rejected", note);
    proposal.status = "rejected";
    this.addMessage(
      "assistant",
      "text",
      note ? this.t("session.rejectedWithNote", { note }) : this.t("session.rejected"),
      { proposalId: proposal.id },
    );
    this.emitState();
    return this.getState();
  }

  private fileContext(paths: readonly string[], maxChars = 80_000, root = this.root): string {
    const chunks: string[] = [];
    let total = 0;
    for (const path of unique(paths)) {
      if (total >= maxChars) break;
      try {
        const target = this.safeWritePath(path, root);
        const content = readFileSync(target.absolute, "utf8");
        const budget = Math.min(28_000, maxChars - total);
        const slice = content.slice(0, budget);
        chunks.push(
          `--- FILE: ${path} ---\n${slice}${content.length > budget ? "\n… truncated …" : ""}`,
        );
        total += slice.length;
      } catch {
        // Missing files are expected for new components.
      }
    }
    return chunks.join("\n\n");
  }

  private safeWritePath(
    relativePath: string,
    root = this.root,
  ): { relative: string; absolute: string } {
    const clean = normalizeProjectPath(relativePath);
    const rootReal = resolve(root);
    const absolute = resolve(rootReal, clean);
    if (absolute !== rootReal && !absolute.startsWith(`${rootReal}${sep}`)) {
      throw new Error(this.t("error.pathEscapesRoot", { path: relativePath }));
    }
    if (existsSync(absolute)) {
      const real = realpathSync(absolute);
      if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`)) {
        throw new Error(this.t("error.pathEscapesSymlink", { path: relativePath }));
      }
    }
    return { relative: clean, absolute };
  }

  private writeFileAtomic(absolute: string, content: string): void {
    mkdirSync(dirname(absolute), { recursive: true });
    const temp = `${absolute}.${process.pid}.${ulid()}.tmp`;
    try {
      writeFileSync(temp, content, "utf8");
      renameSync(temp, absolute);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // best effort
      }
      throw error;
    }
  }

  private async implementVersion(proposal: InternalProposal): Promise<void> {
    if (this.abortController) this.abortController.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    let implementationWorkspace: string | null = null;
    const provider = this.deps.settings.providerConfig();
    if (!isProviderConfigured(provider)) {
      this.agentStatus = { phase: "error", message: this.t("session.noProvider") };
      this.emitState();
      return;
    }
    this.agentStatus = {
      phase: "implementing",
      message: this.t("session.implementing", { title: proposal.intent.title }),
      versionId: proposal.id,
    };
    this.deps.emit({ type: "agent", status: this.agentStatus, state: this.getState() });
    try {
      await this.ensureScan(signal);
      const workspace = createImplementationWorkspace(this.root);
      implementationWorkspace = workspace;
      const reusePlan =
        proposal.reusePlan ?? this.rag.plan(`${proposal.intent.title}\n${proposal.intent.goal}`);
      proposal.reusePlan = reusePlan;
      const wantedPaths = new Set<string>();
      for (const op of proposal.ops) {
        if (op.op === "node.add" && op.node.file) wantedPaths.add(op.node.file);
        if (op.op === "node.update") {
          const node = this.snapshot.nodes[op.id];
          if (node?.file) wantedPaths.add(node.file);
        }
        if (op.op === "node.remove") {
          const node = this.snapshot.nodes[op.id];
          if (node?.file) wantedPaths.add(node.file);
        }
      }
      for (const nodeIntent of proposal.intent.nodeIntents) {
        const target = this.snapshot.nodes[nodeIntent.facetId ?? nodeIntent.nodeId];
        if (target?.file) wantedPaths.add(target.file);
      }
      for (const candidate of reusePlan.candidates.slice(0, 6)) wantedPaths.add(candidate.path);
      const skills = this.skills.promptFor(`${proposal.intent.title}\n${proposal.intent.goal}`);
      const ekoSystem = `You are Jin's implementation agent running inside Eko. The architecture has already been approved by a human; code must conform to it.
Rules:
- Use architecture to re-read the approved L0/L1/facet graph and structural ops before editing.
- Use search_code before writing a new component, hook, service or helper; reuse an existing unit when it fits.
- Use read_file to inspect current source. Use apply_patch for existing files; every edit is a unified diff and is staged virtually.
- Keep unified-diff hunk line counts exact. Never use placeholder hunk headers; if apply_patch rejects a patch, regenerate it from the current file contents.
- Use write_file only for new files or when a patch cannot represent the change.
- Use delete_file for approved removals. All edits are staged virtually; they are applied atomically after the run.
- Use run_shell for bounded project checks or inspection. Commands must stay inside the project, time out quickly, and are audited in .jin/cache/shell-audit.jsonl.
- Never modify .jin/, .git/, node_modules/, dist/, dist-electron/, or release/. The tools reject those paths.
- Keep the change within approved files or their conventional test companions. Do not add helper files unless they are explicitly present in the approved architecture scope.
- Work until the implementation is complete, then finish with a short plain-text summary of what changed.
- If an approved file cannot be implemented, explain why in the summary instead of inventing unrelated files.`;
      const settings = this.deps.settings.get();
      const allowedPaths = implementationScopePaths(
        proposal.intent,
        proposal.ops,
        proposal.touches,
        proposal.targetSnapshot,
        proposal.baseSnapshot,
      );
      if (allowedPaths.size === 0) {
        throw new Error("The approved architecture proposal does not authorize any source paths.");
      }
      const independentTasks = independentImplementationTasks(proposal.intent.tasks);
      const assignedTasks: Array<IntentTask | null> = independentTasks
        ? [...independentTasks]
        : [null];
      const workerInput = (
        task: IntentTask | null,
      ): { text: string; scope: ReadonlySet<string> } => {
        const workerIntent = task ? { ...proposal.intent, tasks: [task] } : proposal.intent;
        const readPaths = task
          ? unique([
              ...task.files!,
              ...reusePlan.candidates.slice(0, 6).map((candidate) => candidate.path),
            ])
          : unique([...wantedPaths]);
        const workerContext = this.fileContext(readPaths, 80_000, workspace);
        return {
          text: [
            `Intent:\n${JSON.stringify(workerIntent, null, 2)}`,
            `Approved structural ops:\n${JSON.stringify(proposal.ops, null, 2)}`,
            `Touch records:\n${JSON.stringify(proposal.touches, null, 2)}`,
            `ReusePlan:\n${JSON.stringify(reusePlan, null, 2)}`,
            task
              ? `Assigned task:\n${JSON.stringify(task, null, 2)}\nOnly implement this task in these approved paths: ${task.files?.join(", ")}`
              : "Implement the approved Intent and all its tasks.",
            skills ? `Skills:\n${skills}` : "",
            workerContext
              ? `Existing source context:\n${workerContext}`
              : "No existing source files were selected.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          scope: task ? implementationTaskPaths(task.files ?? []) : allowedPaths,
        };
      };
      const warnings: string[] = [];
      let rawEditBatches: Array<{ edits: unknown[]; scope: ReadonlySet<string> }> = [];
      let summary = "";
      let notes: string[] = [];
      this.agentStatus = {
        ...this.agentStatus,
        message: this.t("session.ekoImplementing"),
      };
      this.deps.emit({ type: "agent", status: this.agentStatus, state: this.getState() });
      this.startStream(this.t("chat.streamImplementing"), proposal.id);
      const settled = await Promise.allSettled(
        assignedTasks.map(async (task, index) => {
          const worker = workerInput(task);
          const workerLabel = task ? `[${index + 1}/${assignedTasks.length}] ${task.title}` : "Eko";
          const workerWorkspace =
            assignedTasks.length === 1 ? workspace : createImplementationWorkspace(workspace);
          try {
            const eko = await runEkoCoder({
              root: workerWorkspace,
              provider: provider as ProviderConfig,
              system: ekoSystem,
              task: `${worker.text}\n\nImplement only the assigned task using the staging tools. Finish with a short summary.`,
              temperature: settings.agent.temperature,
              maxTokens: settings.agent.maxTokens,
              signal,
              snapshot: this.snapshot,
              intent: task ? { ...proposal.intent, tasks: [task] } : proposal.intent,
              ops: proposal.ops,
              reusePlan,
              searchCode: (query, limit) => this.rag.search(query, limit ?? 8),
              onUsage: (usage) => this.recordUsage("eko", provider.model, usage),
              onText: (text, done) => {
                if (signal.aborted) return;
                this.updateStream(text, {
                  label: `${workerLabel} · ${this.t("chat.streamImplementing")}`,
                  phase: done ? "thinking" : "responding",
                });
              },
              onProgress: (message) => {
                if (signal.aborted) return;
                this.agentStatus = {
                  ...this.agentStatus,
                  message: `${workerLabel}: ${message}`,
                };
                this.updateStream(this.stream?.content ?? "", {
                  label: `${workerLabel}: ${message}`,
                  phase: "thinking",
                });
                this.deps.emit({
                  type: "agent",
                  status: this.agentStatus,
                  state: this.getState(),
                });
              },
            });
            if (eko.edits.length === 0) {
              throw new Error(`Task ${index + 1} did not stage any source changes.`);
            }
            return { worker, eko };
          } finally {
            if (workerWorkspace !== workspace) disposeImplementationWorkspace(workerWorkspace);
          }
        }),
      );
      const failedWorker = settled.find((result) => result.status === "rejected");
      if (failedWorker?.status === "rejected") throw failedWorker.reason;
      const workerResults = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      rawEditBatches = workerResults.map(({ worker, eko }) => ({
        edits: eko.edits,
        scope: worker.scope,
      }));
      summary = workerResults
        .map(({ eko }) => eko.summary)
        .filter(Boolean)
        .join("\n");
      notes = workerResults.flatMap(({ eko }) => eko.notes);
      warnings.push(...workerResults.flatMap(({ eko }) => eko.warnings));
      this.finishStream();
      const changedFiles: string[] = [];
      const deletedFiles: string[] = [];
      const appliedEdits: Array<{ path: string; content: string }> = [];
      const originalFiles = new Map<string, { exists: boolean; content: string }>();
      const stagedFiles = new Map<string, StagedFileEdit>();
      const editErrors: string[] = [];
      const currentFile = (target: { absolute: string }) => {
        const staged = stagedFiles.get(target.absolute);
        if (staged) return { exists: staged.content !== null, content: staged.content ?? "" };
        let original = originalFiles.get(target.absolute);
        if (!original) {
          const exists = existsSync(target.absolute);
          original = {
            exists,
            content: exists ? readFileSync(target.absolute, "utf8") : "",
          };
          originalFiles.set(target.absolute, original);
        }
        return { exists: original.exists, content: original.content };
      };
      const stageFile = (
        target: { relative: string; absolute: string },
        content: string | null,
      ): void => {
        if (!originalFiles.has(target.absolute)) currentFile(target);
        const original = originalFiles.get(target.absolute);
        if (!original) throw new Error(`Missing original state for ${target.relative}`);
        stagedFiles.set(target.absolute, {
          path: target.relative,
          absolute: target.absolute,
          content,
          originalExists: original.exists,
          originalContent: original.content,
        });
      };
      for (const batch of rawEditBatches)
        for (const raw of batch.edits) {
          if (signal.aborted) throw new Error(this.t("error.implementationCancelled"));
          if (typeof raw !== "object" || raw === null) {
            editErrors.push("The model returned an edit that is not an object.");
            continue;
          }
          const edit = raw as Record<string, unknown>;
          const path = typeof edit.path === "string" ? edit.path : "";
          if (typeof edit.patch === "string" && edit.patch.trim()) {
            let patchedFiles;
            try {
              patchedFiles = parseUnifiedPatch(edit.patch, path || undefined);
            } catch (error) {
              editErrors.push(
                this.t("session.patchFailed", {
                  path: path || this.t("common.patch"),
                  message: error instanceof Error ? error.message : String(error),
                }),
              );
              continue;
            }
            for (const file of patchedFiles) {
              let target;
              try {
                if (!batch.scope.has(file.path)) {
                  throw new Error(`Path is outside this agent's approved task scope: ${file.path}`);
                }
                target = this.safeWritePath(file.path, implementationWorkspace);
              } catch (error) {
                editErrors.push(
                  this.t("session.patchFailed", {
                    path: file.path,
                    message: error instanceof Error ? error.message : String(error),
                  }),
                );
                continue;
              }
              const current = currentFile(target);
              if (file.isNew && current.exists) {
                editErrors.push(this.t("session.skippedExisting", { path: file.path }));
                continue;
              }
              if (!file.isNew && !file.isDelete && !current.exists) {
                editErrors.push(this.t("session.skippedMissing", { path: file.path }));
                continue;
              }
              try {
                const patched = applyUnifiedPatchFile(current.content, file);
                if (patched === null) {
                  if (current.exists) stageFile(target, null);
                  continue;
                }
                if (Buffer.byteLength(patched, "utf8") > MAX_EDIT_BYTES) {
                  editErrors.push(this.t("session.skippedTooLarge", { path: file.path }));
                  continue;
                }
                stageFile(target, patched);
              } catch (error) {
                editErrors.push(
                  this.t("session.patchFailed", {
                    path: file.path,
                    message: error instanceof Error ? error.message : String(error),
                  }),
                );
              }
            }
            continue;
          }
          if (!path) {
            editErrors.push("The model returned an edit without a project-relative path.");
            continue;
          }
          const safePath = normalizeProjectPath(path);
          if (!batch.scope.has(safePath)) {
            throw new Error(`Path is outside this agent's approved task scope: ${safePath}`);
          }
          const target = this.safeWritePath(safePath, implementationWorkspace);
          if (edit.delete === true || edit.content === null) {
            if (currentFile(target).exists) stageFile(target, null);
            continue;
          }
          if (typeof edit.content !== "string") {
            editErrors.push(this.t("session.skippedNotString", { path }));
            continue;
          }
          if (Buffer.byteLength(edit.content, "utf8") > MAX_EDIT_BYTES) {
            editErrors.push(this.t("session.skippedTooLarge", { path }));
            continue;
          }
          stageFile(target, edit.content);
        }
      if (editErrors.length > 0) {
        throw new Error(this.t("session.editBatchFailed", { details: editErrors.join("\n") }));
      }
      const changed = [...stagedFiles.values()].filter((edit) =>
        edit.content === null
          ? edit.originalExists
          : !edit.originalExists || edit.content !== edit.originalContent,
      );
      if (changed.length === 0) {
        throw new Error(this.t("session.noCodeChanges"));
      }
      this.agentStatus = {
        phase: "verifying",
        message: this.t("session.verifying"),
        versionId: proposal.id,
      };
      this.deps.emit({ type: "agent", status: this.agentStatus, state: this.getState() });
      const acceptanceCheck = await reviewProposalAcceptance({
        provider: provider as ProviderConfig,
        intent: proposal.intent,
        ops: proposal.ops,
        snapshot: proposal.targetSnapshot,
        edits: changed,
        signal,
        onUsage: (usage) => this.recordUsage("implement", provider.model, usage),
      });
      if (acceptanceCheck.status !== "pass") {
        throw new Error(
          `The approved proposal acceptance review failed: ${acceptanceCheck.detail}`,
        );
      }
      const integrationEdits = changed.map((edit) => {
        const target = this.safeWritePath(edit.path, this.root);
        return { ...edit, absolute: target.absolute };
      });
      await withProjectWriteLock(this.root, signal, () => {
        assertIntegrationBaselines(integrationEdits, (edit) => {
          const liveExists = existsSync(edit.absolute);
          const liveContent = liveExists ? readFileSync(edit.absolute, "utf8") : "";
          return { exists: liveExists, content: liveContent };
        });
        commitFileTransaction(integrationEdits, {
          writeAtomic: (absolute, content) => this.writeFileAtomic(absolute, content),
          checkCancelled: () => {
            if (signal.aborted) throw new Error(this.t("error.implementationCancelled"));
          },
        });
      });
      for (const edit of changed) {
        changedFiles.push(edit.path);
        if (edit.content === null) deletedFiles.push(edit.path);
        else appliedEdits.push({ path: edit.path, content: edit.content });
      }
      this.agentStatus = {
        phase: "verifying",
        message: this.t("session.verifying"),
        versionId: proposal.id,
      };
      this.deps.emit({ type: "agent", status: this.agentStatus, state: this.getState() });
      const scan = await this.refreshFacts(signal);
      const reuseCheck = evaluateReuse({
        plan: reusePlan,
        scan,
        changedPaths: changedFiles,
        deletedPaths: deletedFiles,
        edits: appliedEdits,
      });
      const languageCheck = this.languageCheck();
      const checks = [
        acceptanceCheck,
        reuseCheck,
        ...(languageCheck ? [languageCheck] : []),
        ...(await runProjectChecks(workspace)),
      ];
      const version = this.snapshot.versions[proposal.id];
      const opRecordIds = proposal.opRecordIds ?? version?.ops ?? [];
      const verification = verifyArchitecture({
        root: this.root,
        snapshot: this.snapshot,
        scan,
        ops: proposal.ops,
        opRecordIds,
      });
      const git = gitState(this.root);
      const implementation: ImplementationRecord = {
        id: ulid(),
        versionId: proposal.id,
        gitCommit: git.commit,
        files: unique([...changedFiles, ...git.files]).slice(0, 300),
        checks: [verification.check, ...checks],
        conformance: verification.results,
        actor: this.currentActor(),
        createdAt: nowIso(),
      };
      const record = makeImplementationRecord(
        this.recordBase(proposal.id, walHeads(this.records)),
        implementation,
      );
      appendRecord(walPath(this.root), record);
      this.localWrites.add(record.id);
      this.refreshFromWal();
      const failed =
        implementation.checks.some((check) => check.status === "fail") ||
        verification.results.some((result) => result.status === "fail");
      const verified = this.snapshot.versions[proposal.id]?.status === "verified";
      const details = [
        this.t("session.summary", { summary: summary || this.t("common.none") }),
        ...notes,
        ...warnings,
        ...implementation.checks.map((check) =>
          this.t("session.checkLine", {
            name: check.name,
            status: check.status,
            detail: check.detail,
          }),
        ),
        ...verification.results
          .filter((result) => result.status === "fail")
          .map((result) =>
            this.t("session.conformanceLine", { evidence: result.evidence.join("; ") }),
          ),
      ].join("\n");
      this.addMessage(
        "assistant",
        "implementation",
        verified
          ? this.t("session.implementationVerified", { title: proposal.intent.title })
          : failed
            ? this.t("session.implementationChecksFailed", { title: proposal.intent.title })
            : this.t("session.implementationIncomplete", { title: proposal.intent.title }),
        { proposalId: proposal.id, details },
      );
      this.agentStatus = this.emptyAgentStatus();
      this.emitState();
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof Error && /cancel/i.test(error.message));
      const toolsUnsupported =
        !cancelled &&
        ((error instanceof ProviderError && error.code === "tools-unsupported") ||
          consumeToolsUnsupportedHint());
      const message = toolsUnsupported
        ? this.t("error.toolsUnsupported", { model: provider.model })
        : this.errorMessage(error);
      this.agentStatus = cancelled
        ? this.emptyAgentStatus()
        : {
            phase: "error",
            message,
          };
      this.addMessage(
        "assistant",
        cancelled ? "text" : "error",
        cancelled
          ? this.t("session.implementationCancelled")
          : this.t("session.implementationFailed", {
              message,
            }),
        {
          proposalId: proposal.id,
          details: toolsUnsupported
            ? [
                error instanceof Error ? error.message : String(error),
                error instanceof ProviderError ? (error.details ?? "") : "",
              ]
                .filter(Boolean)
                .join("\n\n") || undefined
            : error instanceof ProviderError
              ? error.details
              : undefined,
        },
      );
      this.emitState();
    } finally {
      if (this.abortController === controller) this.abortController = null;
      if (implementationWorkspace) {
        try {
          disposeImplementationWorkspace(implementationWorkspace);
        } catch {
          // Workspace cleanup must not hide the implementation result.
        }
      }
    }
  }

  async retryImplementation(versionId?: string): Promise<AppState> {
    if (this.agentStatus.phase !== "idle" && this.agentStatus.phase !== "error") {
      throw new Error(this.t("error.agentAlreadyWorking"));
    }
    const targetId = versionId ?? this.proposal?.id;
    if (!targetId) throw new Error(this.t("error.noVersionSelected"));
    if (this.proposal?.id === targetId && this.proposal.status === "approved") {
      void this.implementVersion(this.proposal);
      return this.getState();
    }
    const version = this.snapshot.versions[targetId];
    if (!version) throw new Error(this.t("error.unknownVersionShort"));
    if (!["approved", "implemented", "verified"].includes(version.status)) {
      throw new Error(this.t("error.approvedOnly"));
    }
    const intent = this.snapshot.intents[version.intentId];
    if (!intent) throw new Error(this.t("error.versionNoIntentShort"));
    if (intent.mode === "architecture") {
      throw new Error(this.t("error.architectureOnlyImplementation"));
    }
    const opRecords = this.records
      .filter((record) => record.versionId === targetId && record.t === "op")
      .sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : 1));
    const touchRecords = this.records.filter(
      (record) => record.versionId === targetId && record.t === "touch",
    );
    const proposal: InternalProposal = {
      id: targetId,
      intent,
      ops: opRecords.map((record) => record.payload as ArchOp),
      touches: touchRecords.map((record) => record.payload as Touch),
      baseSnapshot: cloneSnapshot(this.snapshot),
      targetSnapshot: cloneSnapshot(this.snapshot),
      baseHash: version.baseHash ?? hashSnapshot(this.snapshot),
      targetHash: version.targetHash ?? hashSnapshot(this.snapshot),
      diffHash: version.diffHash ?? diffHashForChanges(intent, [], []),
      diff: diffSnapshots(this.snapshot, this.snapshot),
      risks: [],
      reusePlan: null,
      createdAt: nowIso(),
      status: "approved",
      opRecordIds: version.ops,
    };
    this.proposal = proposal;
    void this.implementVersion(proposal);
    return this.getState();
  }

  cancelAgent(): void {
    this.abortController?.abort();
    this.abortController = null;
    if (this.agentStatus.phase !== "idle") {
      this.agentStatus = {
        phase: "idle",
        message: this.t("session.cancellationRequested"),
      };
      this.emitState();
    }
  }

  async refresh(): Promise<AppState> {
    if (this.refreshFromWal(true)) this.emitState();
    this.branch = this.readGitBranch();
    return this.getState();
  }

  /** Reconstruct a historical version from WAL ancestry without mutating the live fold. */
  replayVersion(versionId: string): VersionReplay {
    if (!this.snapshot.versions[versionId]) {
      throw new Error(this.t("error.unknownVersion", { id: versionId }));
    }
    return replayWalVersion(this.records, versionId);
  }

  getFileTree(): FileNode {
    return buildFileTree(this.root, { ignore: this.config.scan.ignore });
  }

  readFile(path: string): FileContent {
    return readProjectFile(this.root, path);
  }

  resolveExternalFile(path: string): string {
    return resolveProjectFile(this.root, path);
  }

  getTools(): ToolsInfo {
    return this.tools;
  }

  /** Re-detect system and Marketplace language servers after install changes. */
  refreshLsp(): LspStatus[] {
    const files = this.scanResult?.files.map((file) => file.path) ?? [];
    this.lsp = detectLanguageServers(files, this.marketplace.specs());
    this.emitState();
    return this.lsp;
  }

  /**
   * Agent retrieval tool: query the same persisted RAG index used to build the
   * ReusePlan. It is intentionally read-only and never changes the WAL.
   */
  searchCode(query: string, limit = 12): ReuseCandidate[] {
    if (!query.trim()) return [];
    return this.rag.search(query, limit);
  }

  /** Invoke an MCP tool through the audited manager. */
  callMcpTool(
    server: string,
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<import("../../shared/ipc").McpCallResult> {
    return this.mcp.call(server, tool, args);
  }

  async refreshTools(): Promise<ToolsInfo> {
    const [skills, mcpServers] = await Promise.all([
      Promise.resolve(this.skills.list()),
      this.mcp.refresh(),
    ]);
    this.tools = {
      builtin: this.tools.builtin,
      skills,
      mcpServers,
      updatedAt: nowIso(),
    };
    this.emitState();
    return this.tools;
  }

  async installMergeDriver(): Promise<{ ok: boolean; message: string }> {
    return installMergeDriver(this.root, this.deps.settings.get().language);
  }

  mergeInstructions(): string {
    return mergeInstructions(this.root, this.deps.settings.get().language);
  }

  getState(): AppState {
    const project: ProjectInfo = {
      root: this.root,
      name: this.config.project.name,
      languages: this.config.project.languages,
      scanRoots: this.config.scan.roots,
      gitBranch: this.branch,
      initialized: true,
    };
    const wal: WalInfo = {
      records: this.records.length,
      conflicts: this.openConflicts(),
      warnings: this.warnings,
      lastRecordId: this.snapshot.lastRecordId,
    };
    return {
      project,
      snapshot: this.snapshot,
      proposal: this.proposalView(),
      messages: this.messages,
      settings: this.deps.settings.get(),
      recentProjects: this.deps.recentProjects(),
      scan: this.scanStatus,
      lsp: this.lsp,
      tools: this.tools,
      wal,
      metrics: computeProjectMetrics(this.snapshot, this.usage.totals()),
      context: {
        ...this.lastContext,
        model: this.lastContext.model || this.deps.settings.get().provider.model,
      },
      agent: this.agentStatus,
      fold: { conflicts: this.openConflicts(), warnings: this.warnings },
    };
  }

  setConfigTheme(theme: AppState["settings"]["theme"], glass: AppState["settings"]["glass"]): void {
    this.config.ui.theme = theme;
    this.config.ui.glass = glass;
  }

  close(): void {
    this.closed = true;
    this.abortController?.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.sourceTimer) clearTimeout(this.sourceTimer);
    this.watcher?.close();
    for (const watcher of this.sourceWatchers) {
      try {
        watcher.close();
      } catch {
        // best effort
      }
    }
    this.sourceWatchers = [];
    try {
      this.index.close();
    } catch {
      // best effort
    }
  }
}
