import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  Cpu,
  GitMerge,
  KeyRound,
  Layers3,
  Palette,
  Plug,
  RefreshCw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  User,
  Users,
  Wrench,
} from "lucide-react";
import type {
  AppSettings,
  GlassStrength,
  SettingsPatch,
  ThemeMode,
} from "../../shared/ipc";
import type { SettingsTab } from "../state/useJin";
import { copyText } from "../lib/utils";
import { useJin } from "../state/useJin";
import { Modal, ModalHeader, SectionLabel, Spinner } from "./ui";

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Cpu }> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "provider", label: "AI Provider", icon: Cpu },
  { id: "team", label: "Team & WAL", icon: Users },
  { id: "tools", label: "Tools", icon: Wrench },
];

type Draft = {
  theme: ThemeMode;
  glass: GlassStrength;
  reduceMotion: boolean;
  providerKind: AppSettings["provider"]["kind"];
  baseUrl: string;
  model: string;
  autoImplement: boolean;
  temperature: number;
  maxTokens: number;
  userName: string;
  userEmail: string;
};

function draftFrom(settings: AppSettings): Draft {
  return {
    theme: settings.theme,
    glass: settings.glass,
    reduceMotion: settings.ui.reduceMotion,
    providerKind: settings.provider.kind,
    baseUrl: settings.provider.baseUrl,
    model: settings.provider.model,
    autoImplement: settings.agent.autoImplement,
    temperature: settings.agent.temperature,
    maxTokens: settings.agent.maxTokens,
    userName: settings.identity.name,
    userEmail: settings.identity.email,
  };
}

function GeneralTab({
  draft,
  setDraft,
  settings,
}: {
  draft: Draft;
  setDraft: (patch: Partial<Draft>) => void;
  settings: AppSettings;
}) {
  const app = useJin((state) => state.app);
  const closeProject = useJin((state) => state.closeProject);
  const setSettingsOpen = useJin((state) => state.setSettingsOpen);
  const busy = useJin((state) => state.busy);

  return (
    <div className="space-y-6">
      <section>
        <SectionLabel>Appearance</SectionLabel>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="label">Theme</div>
            <div className="segmented w-full">
              {(["dark", "light", "system"] as const).map((theme) => (
                <button
                  key={theme}
                  className={`flex-1 capitalize ${draft.theme === theme ? "active" : ""}`}
                  onClick={() => setDraft({ theme })}
                >
                  {theme}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="label">Liquid glass</div>
            <div className="segmented w-full">
              {(["off", "subtle", "medium", "strong"] as const).map((glass) => (
                <button
                  key={glass}
                  className={`flex-1 capitalize ${draft.glass === glass ? "active" : ""}`}
                  onClick={() => setDraft({ glass })}
                >
                  {glass}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--border)] px-3 py-2.5">
          <input
            type="checkbox"
            className="mt-0.5 accent-cyan-300"
            checked={draft.reduceMotion}
            onChange={(event) => setDraft({ reduceMotion: event.target.checked })}
          />
          <span>
            <span className="block text-[10.5px] font-semibold">Reduce motion</span>
            <span className="mt-0.5 block text-[9px] leading-relaxed text-[var(--faint)]">
              Disable panel transitions, graph entrance effects, and pulsing status indicators.
            </span>
          </span>
        </label>
      </section>

      <section>
        <SectionLabel>Identity</SectionLabel>
        <p className="mt-1 text-[9.5px] leading-relaxed text-[var(--faint)]">
          Your actor identity signs every decision and version in the WAL.
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="label">Name</div>
            <input
              className="field"
              value={draft.userName}
              onChange={(event) => setDraft({ userName: event.target.value })}
              placeholder="Your name"
            />
          </div>
          <div>
            <div className="label">Email</div>
            <input
              className="field"
              value={draft.userEmail}
              onChange={(event) => setDraft({ userEmail: event.target.value })}
              placeholder="Optional"
            />
          </div>
        </div>
        <div className="mt-2">
          <div className="label">Actor id</div>
          <div className="font-mono-ui rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] px-2.5 py-2 text-[9px] text-[var(--faint)]">
            {settings.identity.actorId}
          </div>
        </div>
      </section>

      <section>
        <SectionLabel>Current project</SectionLabel>
        {app?.project ? (
          <div className="mt-2 inner-panel p-3">
            <div className="flex items-center gap-2">
              <Layers3 size={13} className="text-[var(--accent)]" />
              <span className="text-[11px] font-bold">{app.project.name}</span>
              {app.project.gitBranch ? (
                <span className="chip ml-auto">{app.project.gitBranch}</span>
              ) : null}
            </div>
            <div className="font-mono-ui mt-1 truncate text-[9px] text-[var(--faint)]">
              {app.project.root}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {app.project.languages.map((language) => (
                <span key={language} className="chip h-[19px] text-[8px]">
                  {language}
                </span>
              ))}
              <span className="chip h-[19px] text-[8px]">
                {app.scan.files} files scanned
              </span>
              <span className="chip h-[19px] text-[8px]">{app.wal.records} WAL records</span>
            </div>
            <button
              className="btn mt-3 h-7 text-[9px]"
              disabled={Boolean(busy)}
              onClick={() => {
                void closeProject();
                setSettingsOpen(false);
              }}
            >
              Close project
            </button>
          </div>
        ) : (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-[9.5px] text-[var(--faint)]">
            No project is open.
          </div>
        )}
      </section>

      <section>
        <SectionLabel>Data</SectionLabel>
        <div className="mt-2 grid gap-2 text-[9.5px] text-[var(--faint)]">
          <div className="flex items-center gap-2">
            <ShieldCheck size={11} className="text-[var(--success)]" />
            API keys are encrypted with the OS keychain and never exposed to the renderer.
          </div>
          <div className="flex items-center gap-2">
            <BookOpen size={11} className="text-[var(--violet)]" />
            The architecture ledger is a single append-only .jin/wal.jsonl file.
          </div>
        </div>
      </section>
    </div>
  );
}

function ProviderTab({
  draft,
  setDraft,
  settings,
  apiKey,
  setApiKey,
  clearKey,
  setClearKey,
}: {
  draft: Draft;
  setDraft: (patch: Partial<Draft>) => void;
  settings: AppSettings;
  apiKey: string;
  setApiKey: (value: string) => void;
  clearKey: boolean;
  setClearKey: (value: boolean) => void;
}) {
  const openai = draft.providerKind === "openai-compatible";
  return (
    <div className="space-y-6">
      <section>
        <SectionLabel>Provider</SectionLabel>
        <p className="mt-1 text-[9.5px] leading-relaxed text-[var(--faint)]">
          Jin speaks the OpenAI chat-completions API. Ollama uses the same protocol at a local
          endpoint. Without a provider, Jin uses its deterministic local planner.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="label">Kind</div>
            <select
              className="field"
              value={draft.providerKind}
              onChange={(event) =>
                setDraft({
                  providerKind: event.target.value as Draft["providerKind"],
                })
              }
            >
              <option value="none">None (local planner only)</option>
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="ollama">Ollama / local</option>
            </select>
          </div>
          <div>
            <div className="label">Model</div>
            <input
              className="field"
              value={draft.model}
              onChange={(event) => setDraft({ model: event.target.value })}
              placeholder="gpt-4o-mini"
              disabled={draft.providerKind === "none"}
            />
          </div>
        </div>
        <div className="mt-3">
          <div className="label">Base URL</div>
          <input
            className="field font-mono-ui"
            value={draft.baseUrl}
            onChange={(event) => setDraft({ baseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
            disabled={draft.providerKind === "none"}
          />
          <div className="hint mt-1">
            Ollama usually runs at http://localhost:11434/v1. Jin appends
            <span className="font-mono-ui"> /chat/completions</span>.
          </div>
        </div>

        {openai ? (
          <div className="mt-3">
            <div className="label">
              API key{" "}
              {settings.provider.hasApiKey ? (
                <span className="normal-case tracking-normal text-[var(--success)]">
                  · stored
                </span>
              ) : null}
            </div>
            <div className="flex gap-2">
              <input
                className="field font-mono-ui"
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  if (event.target.value) setClearKey(false);
                }}
                placeholder={
                  settings.provider.hasApiKey
                    ? "Stored key — leave blank to keep"
                    : "sk-…"
                }
                autoComplete="off"
              />
              {settings.provider.hasApiKey ? (
                <button
                  className={`btn h-[34px] px-2 ${clearKey ? "btn-danger" : ""}`}
                  onClick={() => {
                    setClearKey(!clearKey);
                    setApiKey("");
                  }}
                  title="Delete stored API key on save"
                >
                  <Trash2 size={12} />
                  {clearKey ? "Will delete" : "Clear"}
                </button>
              ) : null}
            </div>
            <div className="hint mt-1 flex items-center gap-1.5">
              <KeyRound size={9} />
              Keys are encrypted with safeStorage and only the main process can read them.
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <SectionLabel>Agent</SectionLabel>
        <label className="mt-2 flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--border)] px-3 py-2.5">
          <input
            type="checkbox"
            className="mt-0.5 accent-cyan-300"
            checked={draft.autoImplement}
            onChange={(event) => setDraft({ autoImplement: event.target.checked })}
          />
          <span>
            <span className="block text-[10.5px] font-semibold">
              Implement automatically after approval
            </span>
            <span className="mt-0.5 block text-[9px] leading-relaxed text-[var(--faint)]">
              Approval always happens first. This only removes a second click between approval
              and the implementation turn.
            </span>
          </span>
        </label>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="label label-row">
              <span>Temperature</span>
              <span className="font-mono-ui text-[var(--text)]">
                {draft.temperature.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={draft.temperature}
              onChange={(event) =>
                setDraft({ temperature: Number(event.target.value) })
              }
              className="w-full accent-cyan-300"
            />
            <div className="hint">Lower is more architectural and predictable.</div>
          </div>
          <div>
            <div className="label">Max output tokens</div>
            <input
              className="field"
              type="number"
              min={512}
              max={32000}
              step={256}
              value={draft.maxTokens}
              onChange={(event) =>
                setDraft({ maxTokens: Number(event.target.value) || 8000 })
              }
            />
            <div className="hint">Complete files need room. 8000 is a safe default.</div>
          </div>
        </div>
      </section>

      {draft.providerKind !== "none" ? (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] p-2.5 text-[9px] leading-relaxed text-[var(--faint)]">
          <Sparkles size={11} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          The provider receives the Intent, approved architecture ops, selected source context,
          and ReusePlan. It never receives your API key in the renderer.
        </div>
      ) : null}
    </div>
  );
}

function TeamTab() {
  const app = useJin((state) => state.app);
  const installMergeDriver = useJin((state) => state.installMergeDriver);
  const getMergeInstructions = useJin((state) => state.getMergeInstructions);
  const notify = useJin((state) => state.notify);
  const busy = useJin((state) => state.busy);
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(false);

  const loadInstructions = async (): Promise<void> => {
    setLoading(true);
    const text = await getMergeInstructions();
    setInstructions(text ?? "");
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <section>
        <SectionLabel>Team merge driver</SectionLabel>
        <p className="mt-1 text-[9.5px] leading-relaxed text-[var(--faint)]">
          The WAL is an operation-level Merkle DAG. Git's textual merge cannot order concurrent
          records causally, so Jin installs a three-way merge driver that writes a deterministic
          union. Rejected versions remain in history and are never applied.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() => void installMergeDriver()}
          >
            <GitMerge size={13} />
            Install Git merge driver
          </button>
          <button
            className="btn"
            disabled={loading}
            onClick={() => void loadInstructions()}
          >
            {loading ? <Spinner size={12} /> : <BookOpen size={12} />}
            Show setup instructions
          </button>
          {instructions ? (
            <button
              className="btn btn-ghost"
              onClick={async () => {
                const ok = await copyText(instructions);
                notify(ok ? "success" : "error", ok ? "Instructions copied." : "Copy failed.");
              }}
            >
              <Copy size={12} />
              Copy
            </button>
          ) : null}
        </div>
        {instructions ? (
          <pre className="font-mono-ui mt-3 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--code-bg)] p-3 text-[9px] leading-relaxed text-[var(--muted)]">
            {instructions}
          </pre>
        ) : null}
        <div className="mt-3 grid gap-2 text-[9px] text-[var(--faint)] sm:grid-cols-2">
          <div className="inner-panel flex items-start gap-2 p-2.5">
            <Check size={11} className="mt-0.5 shrink-0 text-[var(--success)]" />
            .gitattributes is committed so teammates inherit the merge attribute.
          </div>
          <div className="inner-panel flex items-start gap-2 p-2.5">
            <Terminal size={11} className="mt-0.5 shrink-0 text-[var(--violet)]" />
            Each clone runs the two git config commands once; Git never commits driver config.
          </div>
        </div>
      </section>

      <section>
        <SectionLabel>Current ledger</SectionLabel>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <div className="inner-panel p-2.5">
            <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">Records</div>
            <div className="font-mono-ui mt-0.5 text-[16px] font-bold">{app?.wal.records ?? 0}</div>
          </div>
          <div className="inner-panel p-2.5">
            <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">Versions</div>
            <div className="font-mono-ui mt-0.5 text-[16px] font-bold">
              {app?.snapshot ? Object.keys(app.snapshot.versions).length : 0}
            </div>
          </div>
          <div className="inner-panel p-2.5">
            <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">Conflicts</div>
            <div
              className={`font-mono-ui mt-0.5 text-[16px] font-bold ${
                (app?.wal.conflicts.length ?? 0) > 0 ? "text-[var(--danger)]" : ""
              }`}
            >
              {app?.wal.conflicts.length ?? 0}
            </div>
          </div>
        </div>
        {(app?.wal.conflicts.length ?? 0) > 0 ? (
          <div className="mt-2 max-h-[170px] space-y-1 overflow-auto">
            {app?.wal.conflicts.map((conflict, index) => (
              <div
                key={`${conflict.code}:${index}:${conflict.recordIds.join(",")}`}
                className="rounded-lg border border-rose-400/20 bg-rose-400/[0.045] p-2 text-[9px] leading-relaxed text-[var(--muted)]"
              >
                <strong className="text-[var(--danger)]">{conflict.code}</strong>{" "}
                {conflict.message}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2 text-[9px] text-[var(--success)]">
            <ShieldCheck size={11} /> No WAL conflicts.
          </div>
        )}
      </section>

      <section>
        <SectionLabel>Collaboration model</SectionLabel>
        <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] p-3 text-[9px] leading-relaxed text-[var(--faint)]">
          Jin is async and team-first: no real-time cursors, no shared editing sessions. Each
          clone appends ULID-ordered operation records; HLC and parent links preserve causal
          order. Semantic write conflicts surface as conflicted versions for review instead of
          corrupting the ledger.
        </div>
      </section>
    </div>
  );
}

function ToolsTab() {
  const app = useJin((state) => state.app);
  const refreshTools = useJin((state) => state.refreshTools);
  const notify = useJin((state) => state.notify);
  const [refreshing, setRefreshing] = useState(false);
  const tools = app?.tools;

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    await refreshTools();
    setRefreshing(false);
  };

  const copy = async (text: string, label: string): Promise<void> => {
    const ok = await copyText(text);
    notify(ok ? "success" : "error", ok ? `${label} copied.` : "Copy failed.");
  };

  if (!tools) return <div className="text-[10px] text-[var(--faint)]">No tools loaded.</div>;

  const missing = (app?.lsp ?? []).filter((server) => server.status === "missing");
  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center gap-2">
          <SectionLabel>Language servers</SectionLabel>
          <span className="chip ml-auto h-[18px] px-1.5 text-[8px]">
            {missing.length} missing
          </span>
          <button className="btn h-7 px-2 text-[9px]" onClick={() => void refresh()}>
            {refreshing ? <Spinner size={10} /> : <RefreshCw size={10} />}
            Refresh
          </button>
        </div>
        <p className="mt-1 text-[9px] leading-relaxed text-[var(--faint)]">
          LSP depends on the user's environment. Jin detects servers on PATH and uses them for
          locations and simple semantics; it never installs runtimes silently. LLM planning
          handles layers, domains, and responsibilities.
        </p>

        {(app?.lsp ?? []).length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-[9.5px] text-[var(--faint)]">
            No language facts detected yet. Scan a project first.
          </div>
        ) : (
          <div className="mt-2 space-y-1.5">
            {app?.lsp.map((server) => (
              <div
                key={server.id}
                className={`inner-panel p-2.5 ${
                  server.status === "missing" ? "border-amber-300/20" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`status-dot ${
                      server.status === "available"
                        ? "success"
                        : server.status === "missing"
                          ? "warning"
                          : "muted"
                    }`}
                  />
                  <span className="text-[10px] font-semibold">{server.language}</span>
                  <span className="font-mono-ui truncate text-[8.5px] text-[var(--faint)]">
                    {server.server}
                  </span>
                  <span
                    className={`chip ml-auto h-[18px] px-1.5 text-[8px] ${
                      server.status === "missing" ? "chip-warning" : "chip-success"
                    }`}
                  >
                    {server.status}
                  </span>
                </div>
                <div className="mt-1 pl-4 text-[8.5px] leading-relaxed text-[var(--faint)]">
                  {server.detail}
                </div>
                {server.status === "missing" ? (
                  <div className="mt-1.5 flex items-start gap-1.5 pl-4">
                    <AlertTriangle size={9} className="mt-0.5 shrink-0 text-[var(--warning)]" />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono-ui text-[8.5px] leading-relaxed text-[var(--muted)]">
                        {server.installHint}
                      </div>
                    </div>
                    <button
                      className="icon-btn h-6 w-6 shrink-0"
                      onClick={() => void copy(server.installHint, "Install command")}
                      title="Copy install command"
                    >
                      <Copy size={10} />
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2">
          <SectionLabel>Skills</SectionLabel>
          <span className="chip ml-auto h-[18px] px-1.5 text-[8px]">
            {tools.skills.length}
          </span>
        </div>
        <p className="mt-1 text-[9px] leading-relaxed text-[var(--faint)]">
          Project skills live in .jin/skills; user skills live in ~/.config/jin/skills. They are
          always available to the agent and never open a first-use approval.
        </p>
        {tools.skills.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-[9.5px] text-[var(--faint)]">
            No skills installed.
          </div>
        ) : (
          <div className="mt-2 space-y-1.5">
            {tools.skills.map((skill) => (
              <div key={`${skill.scope}:${skill.path}`} className="inner-panel p-2.5">
                <div className="flex items-center gap-2">
                  <Sparkles size={11} className="shrink-0 text-[var(--violet)]" />
                  <span className="text-[10px] font-semibold">{skill.name}</span>
                  <span className="chip ml-auto h-[18px] px-1.5 text-[8px]">
                    {skill.scope}
                  </span>
                </div>
                <div className="mt-1 text-[8.5px] leading-relaxed text-[var(--faint)]">
                  {skill.description}
                </div>
                <div className="font-mono-ui mt-1 truncate text-[8px] text-[var(--faint)]">
                  {skill.path}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2">
          <SectionLabel>MCP servers</SectionLabel>
          <span className="chip ml-auto h-[18px] px-1.5 text-[8px]">
            {tools.mcpServers.length}
          </span>
        </div>
        <p className="mt-1 text-[9px] leading-relaxed text-[var(--faint)]">
          Stdio, HTTP, and SSE servers are discovered from .jin/config.yaml. Remote MCP is
          allowed; listing and enabling tools never requires first-use approval.
        </p>
        {tools.mcpServers.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-[9.5px] text-[var(--faint)]">
            No MCP servers configured.
          </div>
        ) : (
          <div className="mt-2 space-y-1.5">
            {tools.mcpServers.map((server) => (
              <div key={server.name} className="inner-panel p-2.5">
                <div className="flex items-center gap-2">
                  <Server size={11} className="shrink-0 text-[var(--accent)]" />
                  <span className="text-[10px] font-semibold">{server.name}</span>
                  <span className="chip h-[18px] px-1.5 text-[8px]">{server.transport}</span>
                  <span
                    className={`chip ml-auto h-[18px] px-1.5 text-[8px] ${
                      server.status === "ready"
                        ? "chip-success"
                        : server.status === "error"
                          ? "chip-danger"
                          : ""
                    }`}
                  >
                    {server.status}
                  </span>
                </div>
                <div className="font-mono-ui mt-1 truncate pl-4 text-[8px] text-[var(--faint)]">
                  {server.target}
                </div>
                {server.error ? (
                  <div className="mt-1 pl-4 text-[8.5px] leading-relaxed text-[var(--danger)]">
                    {server.error}
                  </div>
                ) : null}
                {server.tools.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1 pl-4">
                    {server.tools.map((tool) => (
                      <span key={tool} className="chip h-[18px] text-[8px]">
                        {tool}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionLabel>Built-in tools</SectionLabel>
        <div className="mt-2 flex flex-wrap gap-1">
          {tools.builtin.map((tool) => (
            <span key={tool} className="chip h-[20px] text-[8px]">
              {tool}
            </span>
          ))}
        </div>
      </section>

      <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] p-2.5 text-[9px] leading-relaxed text-[var(--faint)]">
        <Plug size={11} className="mt-0.5 shrink-0 text-[var(--violet)]" />
        Tool access is audited in .jin/cache. Installing or enabling a Skill/MCP server does not
        open an approval dialog; architecture changes still require exactly one.
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const open = useJin((state) => state.settingsOpen);
  const tab = useJin((state) => state.settingsTab);
  const setTab = useJin((state) => state.setSettingsTab);
  const setOpen = useJin((state) => state.setSettingsOpen);
  const app = useJin((state) => state.app);
  const saveSettings = useJin((state) => state.saveSettings);
  const busy = useJin((state) => state.busy);
  const settings = app?.settings;

  const [draft, setDraftState] = useState<Draft | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !settings) return;
    setDraftState(draftFrom(settings));
    setApiKey("");
    setClearKey(false);
    setValidation(null);
    // Reset only when the dialog opens; background state updates must not clobber edits.
  }, [open]);

  const setDraft = (patch: Partial<Draft>): void =>
    setDraftState((current) => (current ? { ...current, ...patch } : current));

  const save = async (): Promise<void> => {
    if (!draft) return;
    if (draft.providerKind !== "none" && !/^https?:\/\//i.test(draft.baseUrl.trim())) {
      setValidation("The provider base URL must start with http:// or https://.");
      setTab("provider");
      return;
    }
    const patch: SettingsPatch = {
      theme: draft.theme,
      glass: draft.glass,
      reduceMotion: draft.reduceMotion,
      providerKind: draft.providerKind,
      providerBaseUrl: draft.baseUrl.trim(),
      providerModel: draft.model.trim(),
      autoImplement: draft.autoImplement,
      temperature: draft.temperature,
      maxTokens: draft.maxTokens,
      userName: draft.userName,
      userEmail: draft.userEmail,
    };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    else if (clearKey) patch.apiKey = null;
    const ok = await saveSettings(patch);
    if (ok) setOpen(false);
  };

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      className="settings-modal"
      label="Settings"
    >
      <ModalHeader
        title="Settings"
        subtitle="Application preferences, AI provider, team merge, and tool discovery."
        onClose={() => setOpen(false)}
        icon={<SlidersHorizontal size={16} />}
      />
      <div className="settings-grid min-h-0 flex-1">
        <nav className="modal-sidebar min-h-0 space-y-1 overflow-y-auto p-2.5">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item ${tab === item.id ? "active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={13} />
              {item.label}
            </button>
          ))}
          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] p-2 text-[8.5px] leading-relaxed text-[var(--faint)]">
            <div className="flex items-center gap-1.5 font-semibold text-[var(--muted)]">
              <Palette size={10} /> Inner-content glass
            </div>
            <div className="mt-1">
              Native window frame and menu stay outside the glass treatment.
            </div>
          </div>
          <div className="mt-2 flex items-center gap-1.5 px-1 text-[8px] text-[var(--faint)]">
            <User size={9} />
            <span className="truncate">{settings?.identity.name ?? "Jin user"}</span>
          </div>
        </nav>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {!draft || !settings ? (
            <div className="flex h-full items-center justify-center text-[10px] text-[var(--faint)]">
              <Spinner size={13} /> Loading settings…
            </div>
          ) : tab === "general" ? (
            <GeneralTab draft={draft} setDraft={setDraft} settings={settings} />
          ) : tab === "provider" ? (
            <>
              {validation ? (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-400/25 bg-rose-400/[0.05] p-2.5 text-[9.5px] text-[var(--danger)]">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                  {validation}
                </div>
              ) : null}
              <ProviderTab
                draft={draft}
                setDraft={setDraft}
                settings={settings}
                apiKey={apiKey}
                setApiKey={setApiKey}
                clearKey={clearKey}
                setClearKey={setClearKey}
              />
            </>
          ) : tab === "team" ? (
            <TeamTab />
          ) : (
            <ToolsTab />
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-soft)] px-4 py-3">
        <div className="flex items-center gap-1.5 text-[8.5px] text-[var(--faint)]">
          <ShieldCheck size={10} />
          Settings are stored in Electron userData, not the repository.
        </div>
        <button className="btn ml-auto h-8" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          className="btn btn-primary h-8 px-4"
          onClick={() => void save()}
          disabled={!draft || Boolean(busy)}
        >
          Save settings
        </button>
      </div>
    </Modal>
  );
}
