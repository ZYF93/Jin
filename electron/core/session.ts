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
import { dirname, join, resolve, sep } from "node:path";
import type { ArchDiff, RiskHint } from "../../shared/arch/diff";
import type {
  ArchNode,
  ArchOp,
  ArchSnapshot,
  Actor,
  Decision,
  ImplementationRecord,
  Intent,
  IntentTask,
  Touch,
  WalConflict,
} from "../../shared/arch/types";
import type {
  AgentStatus,
  AppState,
  ChatMessage,
  FileContent,
  FileNode,
  JinEvent,
  LspStatus,
  ProjectInfo,
  ProposalView,
  ReusePlan,
  ScanStatus,
  ToolsInfo,
  WalInfo,
} from "../../shared/ipc";
import type { WalRecord } from "../../shared/wal/types";
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
import { localPlan } from "./agent/local-planner";
import { planWithProvider } from "./agent/llm-planner";
import { normalizePlan } from "./agent/normalize-plan";
import type { PlanDraft } from "./agent/plan-types";
import { completeJson, type ProviderConfig } from "./agent/provider";
import {
  readConfig,
  walPath,
  cachePath,
  type JinConfig,
} from "./project/config";
import { loadWal, appendRecord } from "./wal/io";
import { foldWal } from "./wal/fold";
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
import { RagService } from "./rag/rag";
import { SkillManager } from "./skills/manager";
import { McpManager } from "./mcp/manager";
import { diffScanToOps } from "./scan/import";
import { scanProject, type ScanResult } from "./scan/scanner";
import {
  gitState,
  runProjectChecks,
  verifyArchitecture,
} from "./verify/verify";
import { installMergeDriver, mergeInstructions } from "./git/merge-driver";
import type { SettingsStore } from "./settings/app-settings";

const CHAT_FILE = "chat.json";
const MAX_CHAT_MESSAGES = 240;
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export interface SessionDeps {
  settings: SettingsStore;
  recentProjects: () => import("../../shared/ipc").RecentProject[];
  emit: (event: JinEvent) => void;
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
}

function nowIso(): string {
  return new Date().toISOString();
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function latestHlc(records: readonly WalRecord[]): Hlc | null {
  let best: Hlc | null = null;
  for (const record of records) {
    try {
      const hlc = parseHlc(record.hlc);
      if (
        !best ||
        hlc.wall > best.wall ||
        (hlc.wall === best.wall && hlc.counter > best.counter)
      ) {
        best = hlc;
      }
    } catch {
      // A malformed record is reported by the WAL parser; ignore its clock here.
    }
  }
  return best;
}

function emptyScanStatus(): ScanStatus {
  return {
    phase: "idle",
    files: 0,
    symbols: 0,
    nodes: 0,
    edges: 0,
    message: "No scan yet.",
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

function emptyAgentStatus(): AgentStatus {
  return { phase: "idle", message: "Ready." };
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
  private scanStatus: ScanStatus = emptyScanStatus();
  private lsp: LspStatus[] = [];
  private scanResult: ScanResult | null = null;
  private rag = new RagService();
  private readonly skills: SkillManager;
  private readonly mcp: McpManager;
  private tools: ToolsInfo;
  private agentStatus: AgentStatus = emptyAgentStatus();
  private clock: HlcClock;
  private actor: Actor;
  private watcher: FSWatcher | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private abortController: AbortController | null = null;
  private closed = false;
  private branch: string | null = null;

  constructor(root: string, deps: SessionDeps) {
    this.root = resolve(root);
    this.deps = deps;
    this.config = readConfig(this.root);
    this.skills = new SkillManager(this.root);
    this.mcp = new McpManager(this.root);
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
    this.loadWalIntoState();
    this.messages = this.loadChat();
    this.lsp = detectLanguageServers();
    this.startWatcher();
  }

  async initialize(): Promise<void> {
    if (this.records.length === 0) {
      if (this.messages.length === 0) {
        this.addMessage(
          "system",
          "text",
          `Opened ${this.config.project.name}. The WAL is empty; scanning the repository to create the first import proposal.`,
        );
      }
      try {
        await this.scan();
      } catch (error) {
        this.addMessage(
          "assistant",
          "error",
          `Initial scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      if (this.messages.length === 0) {
        this.addMessage(
          "system",
          "text",
          `Opened ${this.config.project.name}. Loaded ${this.records.length} WAL records and ${Object.keys(this.snapshot.nodes).length} architecture nodes.`,
        );
      }
      this.scanStatus = { ...this.scanStatus, phase: "scanning", message: "Refreshing source facts…" };
      void this.refreshFacts().catch((error: unknown) => {
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

  private currentActor(): Actor {
    const identity = this.deps.settings.get().identity;
    return {
      id: identity.actorId,
      kind: "user",
      name: identity.name || "Jin user",
      ...(identity.email ? { email: identity.email } : {}),
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
      this.warnings = loaded.errors.map((error) => `WAL line ${error.line}: ${error.message}`);
      this.scanStatus = { ...this.scanStatus, phase: "failed", message: "WAL has parse errors" };
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
        `SQLite index could not be rebuilt: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  }

  private refreshFromWal(): boolean {
    const loaded = loadWal(walPath(this.root));
    if (loaded.errors.length > 0) {
      this.warnings = loaded.errors.map((error) => `WAL line ${error.line}: ${error.message}`);
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
        `SQLite index could not be rebuilt: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
    if (
      this.proposal?.status === "in_review" &&
      hashSnapshot(this.snapshot) !== this.proposal.baseHash
    ) {
      this.proposal.status = "stale";
    }
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
          if (this.refreshFromWal()) this.emitState();
        }, 180);
      });
    } catch {
      this.watcher = null;
    }
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

  private proposalStatus(): ProposalView["status"] {
    const proposal = this.proposal;
    if (!proposal) return "approved";
    if (
      proposal.status === "in_review" &&
      hashSnapshot(this.snapshot) !== proposal.baseHash
    ) {
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
    };
  }

  private scanStatusSummary(scan: ScanResult): string {
    const warnings = scan.warnings.slice(0, 3).join(" ");
    return warnings
      ? `${scan.stats.files} files, ${scan.stats.nodes} nodes. ${warnings}`
      : `${scan.stats.files} files, ${scan.stats.symbols} symbols, ${scan.stats.nodes} nodes.`;
  }

  private async refreshFacts(signal?: AbortSignal): Promise<ScanResult> {
    this.scanStatus = { ...this.scanStatus, phase: "scanning", message: "Scanning source facts…" };
    this.emitState();
    const scan = scanProject(this.root, this.config, { signal });
    this.scanResult = scan;
    this.rag.update(this.root, scan, this.snapshot);
    this.lsp = detectLanguageServers(scan.files.map((file) => file.path));
    this.scanStatus = {
      phase: "ready",
      files: scan.stats.files,
      symbols: scan.stats.symbols,
      nodes: scan.stats.nodes,
      edges: scan.stats.edges,
      message: this.scanStatusSummary(scan),
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
      throw new Error(`Proposal has conflicts: ${preview.conflicts.join("; ")}`);
    }
    const target = preview.snapshot;
    const intentConflicts = applyIntent(target, intent);
    if (intentConflicts.length > 0) {
      throw new Error(`Intent targets missing nodes: ${intentConflicts.map((item) => item.message).join("; ")}`);
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

  private makeIntent(plan: PlanDraft, versionId: string, nodeIntents: Intent["nodeIntents"]): Intent {
    const tasks: IntentTask[] = plan.tasks.length
      ? plan.tasks.map((task) => ({
          id: ulid(),
          title: task.title,
          status: "pending",
          dependsOn: [],
          acceptance: task.acceptance,
        }))
      : [
          {
            id: ulid(),
            title: plan.title,
            status: "pending",
            dependsOn: [],
            acceptance: ["The implementation matches the approved intent and architecture"],
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
        ? this.snapshot.nodes[nodeIntent.facetId]?.parentId ?? nodeIntent.nodeId
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

  private async ensureScan(signal?: AbortSignal): Promise<ScanResult> {
    if (this.scanResult) return this.scanResult;
    return this.refreshFacts(signal);
  }

  async sendMessage(text: string): Promise<AppState> {
    const request = text.trim();
    if (!request) return this.getState();
    if (this.proposal?.status === "in_review") {
      throw new Error("Approve or reject the current proposal before starting another turn.");
    }
    if (this.agentStatus.phase === "planning" || this.agentStatus.phase === "implementing" || this.agentStatus.phase === "verifying") {
      throw new Error("The agent is already working. Wait or cancel the current run.");
    }
    this.addMessage("user", "text", request);
    this.agentStatus = { phase: "planning", message: "Planning the turn…" };
    this.deps.emit({ type: "agent", status: this.agentStatus, state: this.getState() });
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    try {
      await this.ensureScan(signal);
      const reusePlan = this.rag.plan(request);
      const provider = this.deps.settings.providerConfig();
      const configured =
        provider.kind === "ollama" ||
        (provider.kind === "openai-compatible" && Boolean(provider.apiKey));
      let plan: PlanDraft;
      let plannerWarning = "";
      if (configured) {
        try {
          plan = await planWithProvider(provider as ProviderConfig, request, {
            snapshot: this.snapshot,
            skills: this.skills.promptFor(request),
            reuseSummary: reusePlan.summary + "\n" + reusePlan.candidates
              .slice(0, 5)
              .map((candidate) => `- ${candidate.path}: ${candidate.reason}`)
              .join("\n"),
          });
        } catch (error) {
          plannerWarning = `AI planner unavailable (${error instanceof Error ? error.message : String(error)}). Used the local planner instead.`;
          plan = localPlan(this.snapshot, request);
        }
      } else {
        plan = localPlan(this.snapshot, request);
      }
      const versionId = ulid();
      const normalized = normalizePlan(plan, this.snapshot, versionId);
      const intent = this.makeIntent(plan, versionId, normalized.nodeIntents);
      const touches = this.touchesForIntent(normalized.nodeIntents, normalized.ops, intent);
      const proposal = this.makeProposal(intent, normalized.ops, touches, reusePlan);
      this.proposal = proposal;
      const notes = [...normalized.warnings];
      if (plannerWarning) notes.push(plannerWarning);
      const reuseText =
        reusePlan.candidates.length > 0
          ? `ReusePlan: ${reusePlan.candidates.slice(0, 3).map((candidate) => candidate.path).join(", ")}.`
          : "ReusePlan: no close existing unit found; the implementation must justify new code.";
      this.addMessage(
        "assistant",
        "proposal",
        `${plan.assistantMessage}\n\n${reuseText}${notes.length ? `\n\nNotes: ${notes.join(" ")}` : ""}`,
        { proposalId: proposal.id },
      );
      this.agentStatus = emptyAgentStatus();
      this.emitState();
      return this.getState();
    } catch (error) {
      this.agentStatus = {
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      this.addMessage(
        "assistant",
        "error",
        `I could not prepare a proposal: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.emitState();
      return this.getState();
    } finally {
      this.abortController = null;
    }
  }

  async scan(): Promise<AppState> {
    if (this.proposal?.status === "in_review") {
      throw new Error("Approve or reject the current proposal before rescanning.");
    }
    this.scanStatus = { ...this.scanStatus, phase: "scanning", message: "Scanning source facts…" };
    this.emitState();
    this.abortController = new AbortController();
    try {
      const scan = await this.refreshFacts(this.abortController.signal);
      const importResult = diffScanToOps(this.snapshot, scan);
      if (importResult.ops.length === 0) {
        this.addMessage(
          "assistant",
          "scan",
          `Architecture is in sync with source facts. ${this.scanStatusSummary(scan)}`,
        );
        this.scanStatus = { ...this.scanStatus, phase: "ready" };
        this.emitState();
        return this.getState();
      }
      const empty = Object.keys(this.snapshot.nodes).length === 0;
      const versionId = ulid();
      const title = empty ? "Import existing architecture" : "Sync architecture with source";
      const goal = empty
        ? `Import ${scan.stats.files} source files into a reviewable L0/L1 architecture. Review the module boundaries and responsibilities before approving.`
        : `Bring the approved architecture in line with ${scan.stats.files} scanned source files. ${importResult.addedNodes} additions, ${importResult.updatedNodes} updates, ${importResult.removedNodes} removals.`;
      const intent: Intent = {
        id: ulid(),
        versionId,
        title,
        goal,
        tasks: [
          {
            id: ulid(),
            title: empty ? "Review the initial architecture import" : "Review the source synchronization",
            status: "pending",
            dependsOn: [],
            acceptance: [
              "Every L0 module has a recognizable responsibility",
              "L1 units map to real files",
              "Removals do not delete still-needed architecture",
            ],
          },
        ],
        nodeIntents: [],
        author: this.currentActor(),
        createdAt: nowIso(),
      };
      const proposal = this.makeProposal(intent, importResult.ops, [], null);
      this.proposal = proposal;
      this.addMessage(
        "assistant",
        "scan",
        `${empty ? "Initial architecture import" : "Architecture sync"} is ready for review: ${importResult.addedNodes} added, ${importResult.updatedNodes} updated, ${importResult.removedNodes} removed. ${this.scanStatusSummary(scan)}`,
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
        `Scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.emitState();
      return this.getState();
    } finally {
      this.abortController = null;
    }
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

  private appendBundle(proposal: InternalProposal, decision: "approved" | "rejected", note: string): void {
    const versionId = proposal.id;
    const heads = walHeads(this.records);
    const intentRecord = makeIntentRecord(
      this.recordBase(versionId, heads),
      proposal.intent,
    );
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
    const decisionRecord = makeDecisionRecord(
      this.recordBase(versionId, parents),
      decisionPayload,
    );
    const records: WalRecord[] = [
      intentRecord,
      ...opRecords,
      ...touchRecords,
      decisionRecord,
    ];
    for (const record of records) {
      appendRecord(walPath(this.root), record);
    }
    proposal.opRecordIds = opRecords.map((record) => record.id);
    this.refreshFromWal();
  }

  async approveProposal(id: string, note = ""): Promise<AppState> {
    const proposal = this.proposal;
    if (!proposal || proposal.id !== id) throw new Error("No matching proposal is in review.");
    if (proposal.status !== "in_review") throw new Error("This proposal is no longer in review.");
    if (hashSnapshot(this.snapshot) !== proposal.baseHash) {
      proposal.status = "stale";
      this.emitState();
      throw new Error("The architecture changed while you were reviewing. Rescan and create a fresh proposal.");
    }
    const preview = previewOps(this.snapshot, proposal.ops, proposal.id);
    if (preview.conflicts.length > 0) {
      proposal.status = "stale";
      this.emitState();
      throw new Error(`The proposal is stale: ${preview.conflicts.join("; ")}`);
    }
    const target = preview.snapshot;
    const intentConflicts = applyIntent(target, proposal.intent);
    if (intentConflicts.length > 0) throw new Error(intentConflicts[0]?.message ?? "Intent target missing");
    for (const touch of proposal.touches) {
      const conflict = applyTouch(target, touch);
      if (conflict) throw new Error(conflict.message);
    }
    if (hashSnapshot(target) !== proposal.targetHash) {
      proposal.status = "stale";
      this.emitState();
      throw new Error("The target snapshot changed since review; rescan before approving.");
    }
    if (diffHashForChanges(proposal.intent, proposal.ops, proposal.touches) !== proposal.diffHash) {
      throw new Error("The proposal change set no longer matches its review hash.");
    }
    try {
      this.appendBundle(proposal, "approved", note);
    } catch (error) {
      this.addMessage("assistant", "error", `Approval was written incompletely: ${error instanceof Error ? error.message : String(error)}`);
      this.emitState();
      throw error;
    }
    proposal.status = "approved";
    const version = this.snapshot.versions[proposal.id];
    const ordinal = version?.ordinal ?? "?";
    this.addMessage(
      "assistant",
      "text",
      `Approved version ${ordinal}. ${this.deps.settings.isAgentConfigured() ? "Starting implementation." : "No AI provider is configured, so implementation is paused. Open Settings to configure one."}`,
      { proposalId: proposal.id },
    );
    this.emitState();
    if (this.deps.settings.isAgentConfigured() && this.deps.settings.get().agent.autoImplement) {
      void this.implementVersion(proposal);
    }
    return this.getState();
  }

  async rejectProposal(id: string, note = ""): Promise<AppState> {
    const proposal = this.proposal;
    if (!proposal || proposal.id !== id) throw new Error("No matching proposal is in review.");
    if (proposal.status !== "in_review" && proposal.status !== "stale") {
      throw new Error("This proposal is no longer rejectable.");
    }
    this.appendBundle(proposal, "rejected", note);
    proposal.status = "rejected";
    this.addMessage("assistant", "text", `Rejected the proposal${note ? `: ${note}` : "."}`, {
      proposalId: proposal.id,
    });
    this.emitState();
    return this.getState();
  }

  private fileContext(paths: readonly string[], maxChars = 80_000): string {
    const chunks: string[] = [];
    let total = 0;
    for (const path of unique(paths)) {
      if (total >= maxChars) break;
      try {
        const content = readFileSync(join(this.root, path), "utf8");
        const budget = Math.min(28_000, maxChars - total);
        const slice = content.slice(0, budget);
        chunks.push(`--- FILE: ${path} ---\n${slice}${content.length > budget ? "\n… truncated …" : ""}`);
        total += slice.length;
      } catch {
        // Missing files are expected for new components.
      }
    }
    return chunks.join("\n\n");
  }

  private safeWritePath(relativePath: string): { relative: string; absolute: string } {
    const clean = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (!clean || clean.includes("\0") || clean.startsWith("/") || /^[A-Za-z]:\//.test(clean)) {
      throw new Error(`Unsafe file path: ${relativePath}`);
    }
    const parts = clean.split("/");
    const blocked = new Set([".git", ".jin", "node_modules", "dist", "dist-electron", "release"]);
    if (parts.some((part) => part === "..") || blocked.has(parts[0] ?? "")) {
      throw new Error(`Refusing to write Jin/Git/toolchain path: ${relativePath}`);
    }
    const rootReal = resolve(this.root);
    const absolute = resolve(rootReal, clean);
    if (absolute !== rootReal && !absolute.startsWith(`${rootReal}${sep}`)) {
      throw new Error(`Path escapes the project root: ${relativePath}`);
    }
    if (existsSync(absolute)) {
      const real = realpathSync(absolute);
      if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`)) {
        throw new Error(`Path escapes through a symlink: ${relativePath}`);
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
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const provider = this.deps.settings.providerConfig();
    if (provider.kind === "none" || (provider.kind === "openai-compatible" && !provider.apiKey)) {
      this.agentStatus = { phase: "error", message: "No usable AI provider configured." };
      this.emitState();
      return;
    }
    this.agentStatus = {
      phase: "implementing",
      message: `Implementing ${proposal.intent.title}…`,
      versionId: proposal.id,
    };
    this.deps.emit({ type: "agent", status: this.agentStatus, state: this.getState() });
    try {
      await this.ensureScan(signal);
      const reusePlan = proposal.reusePlan ?? this.rag.plan(`${proposal.intent.title}\n${proposal.intent.goal}`);
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
      const context = this.fileContext([...wantedPaths]);
      const skills = this.skills.promptFor(`${proposal.intent.title}\n${proposal.intent.goal}`);
      const system = `You are Jin's implementation agent. The architecture has already been approved by a human; code must conform to it.
Rules:
- Reuse existing code from the provided context before creating new units. Do not duplicate a component/service/hook.
- Write complete file contents, not unified diffs.
- Never modify .jin/, .git/, node_modules/, dist/, dist-electron/, or release/.
- Keep the change scoped to the approved Intent and Ops.
- You may add tests and small internal helpers when needed.
- Return strict JSON only: {"summary":"...","edits":[{"path":"relative/file.ts","content":"complete file content"}],"notes":["..."]}
- Use {"path":"...","delete":true} to delete a file.
- If an approved file cannot be implemented, explain it in notes rather than inventing unrelated files.`;
      const user = [
        `Intent:\n${JSON.stringify(proposal.intent, null, 2)}`,
        `Approved structural ops:\n${JSON.stringify(proposal.ops, null, 2)}`,
        `Touch records:\n${JSON.stringify(proposal.touches, null, 2)}`,
        `ReusePlan:\n${JSON.stringify(reusePlan, null, 2)}`,
        skills ? `Skills:\n${skills}` : "",
        context ? `Existing source context:\n${context}` : "No existing source files were selected.",
        "Return the JSON object now.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const json = await completeJson(provider as ProviderConfig, system, user, {
        temperature: this.deps.settings.get().agent.temperature,
        maxTokens: this.deps.settings.get().agent.maxTokens,
        json: true,
        signal,
      });
      const rawEdits = Array.isArray(json.edits) ? json.edits : [];
      const changedFiles: string[] = [];
      const warnings: string[] = [];
      for (const raw of rawEdits) {
        if (signal.aborted) throw new Error("Implementation cancelled");
        if (typeof raw !== "object" || raw === null) continue;
        const edit = raw as Record<string, unknown>;
        const path = typeof edit.path === "string" ? edit.path : "";
        if (!path) continue;
        const target = this.safeWritePath(path);
        if (edit.delete === true || edit.content === null) {
          if (existsSync(target.absolute)) {
            unlinkSync(target.absolute);
            changedFiles.push(target.relative);
          }
          continue;
        }
        if (typeof edit.content !== "string") {
          warnings.push(`Skipped ${path}: content must be a string`);
          continue;
        }
        if (Buffer.byteLength(edit.content, "utf8") > MAX_EDIT_BYTES) {
          warnings.push(`Skipped ${path}: content exceeds 2 MB`);
          continue;
        }
        this.writeFileAtomic(target.absolute, edit.content);
        changedFiles.push(target.relative);
      }
      const summary = typeof json.summary === "string" ? json.summary : "";
      const notes = Array.isArray(json.notes)
        ? json.notes.filter((note): note is string => typeof note === "string")
        : [];
      this.agentStatus = {
        phase: "verifying",
        message: "Running project checks and architecture conformance…",
        versionId: proposal.id,
      };
      this.deps.emit({ type: "agent", status: this.agentStatus, state: this.getState() });
      const scan = await this.refreshFacts(signal);
      const checks = await runProjectChecks(this.root);
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
      this.refreshFromWal();
      const passed =
        verification.check.status === "pass" &&
        checks.every((check) => check.status !== "fail");
      const details = [
        `Summary: ${summary || "(none)"}`,
        ...notes,
        ...warnings,
        ...implementation.checks.map((check) => `${check.name}: ${check.status} — ${check.detail}`),
        ...verification.results
          .filter((result) => result.status === "fail")
          .map((result) => `Conformance: ${result.evidence.join("; ")}`),
      ].join("\n");
      this.addMessage(
        "assistant",
        "implementation",
        passed
          ? `Implementation recorded and verified for ${proposal.intent.title}.`
          : `Implementation recorded for ${proposal.intent.title}, but some checks or conformance results failed. Review the details before committing.`,
        { proposalId: proposal.id, details },
      );
      this.agentStatus = emptyAgentStatus();
      this.emitState();
    } catch (error) {
      const cancelled =
        signal.aborted ||
        (error instanceof Error && /cancel/i.test(error.message));
      this.agentStatus = cancelled
        ? emptyAgentStatus()
        : {
            phase: "error",
            message: error instanceof Error ? error.message : String(error),
          };
      this.addMessage(
        "assistant",
        cancelled ? "text" : "error",
        cancelled
          ? "Implementation cancelled."
          : `Implementation failed: ${error instanceof Error ? error.message : String(error)}`,
        { proposalId: proposal.id },
      );
      this.emitState();
    } finally {
      this.abortController = null;
    }
  }

  async retryImplementation(versionId?: string): Promise<AppState> {
    if (this.agentStatus.phase !== "idle" && this.agentStatus.phase !== "error") {
      throw new Error("The agent is already working.");
    }
    const targetId = versionId ?? this.proposal?.id;
    if (!targetId) throw new Error("No version selected for implementation.");
    if (this.proposal?.id === targetId && this.proposal.status === "approved") {
      void this.implementVersion(this.proposal);
      return this.getState();
    }
    const version = this.snapshot.versions[targetId];
    if (!version) throw new Error("Unknown version.");
    if (!["approved", "implemented", "verified"].includes(version.status)) {
      throw new Error("Only approved versions can be implemented.");
    }
    const intent = this.snapshot.intents[version.intentId];
    if (!intent) throw new Error("Version has no intent.");
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
      this.agentStatus = { phase: "idle", message: "Cancellation requested." };
      this.emitState();
    }
  }

  async refresh(): Promise<AppState> {
    if (this.refreshFromWal()) this.emitState();
    this.branch = this.readGitBranch();
    return this.getState();
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
    return installMergeDriver(this.root);
  }

  mergeInstructions(): string {
    return mergeInstructions(this.root);
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
      conflicts: this.conflicts,
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
      agent: this.agentStatus,
      fold: { conflicts: this.conflicts, warnings: this.warnings },
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
    this.watcher?.close();
    try {
      this.index.close();
    } catch {
      // best effort
    }
  }
}

