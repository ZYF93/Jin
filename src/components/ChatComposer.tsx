import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, CornerDownLeft, Cpu, FileCode2, Send, Sparkles } from "lucide-react";
import type { FileNode, ProviderModel, ReasoningEffort } from "../../shared/ipc";
import { useT } from "../lib/i18n";
import { formatCount } from "../lib/utils";
import { useJin } from "../state/useJin";
import { ModelField } from "./ModelField";
import { Spinner } from "./ui";

interface FlatFile {
  name: string;
  path: string;
  directory: string;
}

interface Mention {
  start: number;
  end: number;
  query: string;
}

interface ConfigDraft {
  model: string;
  effort: ReasoningEffort;
  contextWindow: number;
  compactionRatio: number;
}

const EFFORTS: ReasoningEffort[] = ["auto", "low", "medium", "high"];
const CONTEXT_PRESETS = [32_000, 128_000, 200_000, 1_000_000];

function flattenFiles(node: FileNode | null): FlatFile[] {
  if (!node) return [];
  const files: FlatFile[] = [];
  const visit = (entry: FileNode): void => {
    if (entry.type === "file") {
      const index = entry.path.lastIndexOf("/");
      files.push({
        name: entry.name,
        path: entry.path,
        directory: index >= 0 ? entry.path.slice(0, index) : "",
      });
      return;
    }
    for (const child of entry.children ?? []) visit(child);
  };
  for (const child of node.children ?? []) visit(child);
  return files;
}

function effortLabel(t: ReturnType<typeof useT>, effort: ReasoningEffort): string {
  return t(
    effort === "auto"
      ? "chat.effort.auto"
      : effort === "low"
        ? "chat.effort.low"
        : effort === "medium"
          ? "chat.effort.medium"
          : "chat.effort.high",
  );
}

function ComposerConfig({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const app = useJin((state) => state.app);
  const saveSettings = useJin((state) => state.saveSettings);
  const settings = app?.settings;
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsMessage, setModelsMessage] = useState<string | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const loadModels = useCallback(async (): Promise<void> => {
    const current = settingsRef.current;
    if (!current || current.provider.kind === "none" || !current.provider.baseUrl.trim()) {
      setModels([]);
      setModelsMessage(null);
      return;
    }
    setModelsLoading(true);
    setModelsMessage(null);
    try {
      const catalog = await window.jin.listModels({
        kind: current.provider.kind,
        baseUrl: current.provider.baseUrl,
      });
      setModels(catalog.models);
      setModelsMessage(catalog.warning ?? null);
    } catch (error) {
      setModels([]);
      setModelsMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const current = settingsRef.current;
    if (!current) return;
    setDraft({
      model: current.provider.model,
      effort: current.provider.reasoningEffort ?? "auto",
      contextWindow: current.provider.contextWindow ?? 128_000,
      compactionRatio: current.provider.compactionRatio ?? 0.8,
    });
    // The saved provider config is the source for this compact picker.
  }, [open]);

  // Re-fetch whenever the saved provider endpoint changes, not only when the
  // popover opens, so model/effort options stay current.
  useEffect(() => {
    if (!open) return;
    void loadModels();
  }, [
    open,
    loadModels,
    settings?.provider.kind,
    settings?.provider.baseUrl,
    settings?.provider.hasApiKey,
  ]);

  if (!open || !draft) return null;

  const set = (patch: Partial<ConfigDraft>): void =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const selectedModel = models.find((model) => model.id === draft.model);
  const efforts = selectedModel?.reasoningEfforts ?? EFFORTS;
  const effortHint = selectedModel
    ? t(
        selectedModel.reasoningSource === "remote"
          ? "chat.effortRemote"
          : selectedModel.reasoningSource === "inferred"
            ? "chat.effortInferred"
            : "chat.effortDefault",
      )
    : t("chat.effortHint");

  const save = async (): Promise<void> => {
    const model = draft.model.trim();
    if (!model) return;
    setSaving(true);
    const ok = await saveSettings({
      providerModel: model,
      providerReasoningEffort: draft.effort,
      providerContextWindow: Math.max(
        1_000,
        Math.round(Number.isFinite(draft.contextWindow) ? draft.contextWindow : 128_000),
      ),
      providerCompactionRatio: draft.compactionRatio,
    });
    setSaving(false);
    if (ok) onClose();
  };

  const compactAt = Math.round(draft.contextWindow * draft.compactionRatio);

  return (
    <div className="absolute right-0 bottom-full left-0 z-30 mb-2 rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] p-3 shadow-2xl">
      <div className="flex items-start gap-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--accent-soft)] text-[var(--accent)]">
          <Cpu size={12} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-bold">{t("chat.composerConfig")}</div>
          <p className="mt-0.5 text-[8.5px] leading-relaxed text-[var(--faint)]">
            {t("chat.composerConfigDetail")}
          </p>
        </div>
      </div>

      <div className="mt-3">
        <div className="label label-row">
          <span>{t("chat.model")}</span>
          {modelsLoading ? <Spinner size={9} /> : null}
        </div>
        <ModelField
          models={models}
          value={draft.model}
          loading={modelsLoading}
          onRefresh={() => void loadModels()}
          onSubmit={() => void save()}
          onChange={(next, found) =>
            set({
              model: next,
              ...(found?.contextWindow ? { contextWindow: found.contextWindow } : {}),
              ...(found && !found.reasoningEfforts.includes(draft.effort)
                ? { effort: "auto" as ReasoningEffort }
                : {}),
            })
          }
          hint={
            modelsMessage
              ? modelsMessage
              : models.length > 0
                ? t("chat.modelsFound", { count: models.length })
                : t("chat.modelHint")
          }
        />
      </div>

      <div className="mt-3">
        <div className="label">{t("chat.effort")}</div>
        <div className="segmented w-full">
          {efforts.map((effort) => (
            <button
              key={effort}
              className={`flex-1 ${draft.effort === effort ? "active" : ""}`}
              onClick={() => set({ effort })}
            >
              {effortLabel(t, effort)}
            </button>
          ))}
        </div>
        <div className="hint mt-1">{effortHint}</div>
      </div>

      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <div>
          <div className="label">{t("chat.contextWindow")}</div>
          <input
            className="field font-mono-ui"
            type="number"
            min={1000}
            max={4_000_000}
            step={1000}
            value={draft.contextWindow}
            onChange={(event) => set({ contextWindow: Number(event.target.value) || 128_000 })}
          />
        </div>
        <div>
          <div className="label label-row">
            <span>{t("chat.compactionRatio")}</span>
            <span className="font-mono-ui text-[var(--text)]">
              {Math.round(draft.compactionRatio * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={Math.round(draft.compactionRatio * 100)}
            onChange={(event) => set({ compactionRatio: Number(event.target.value) / 100 })}
            className="w-full accent-cyan-300"
          />
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {CONTEXT_PRESETS.map((size) => (
          <button
            key={size}
            className={`chip h-[18px] px-1.5 text-[8px] ${
              draft.contextWindow === size ? "chip-success" : ""
            }`}
            onClick={() => set({ contextWindow: size })}
          >
            {formatCount(size)}
          </button>
        ))}
        <span className="ml-auto self-center text-[8px] text-[var(--faint)]">
          {t("chat.contextCompact", {
            ratio: Math.round(draft.compactionRatio * 100),
            tokens: formatCount(compactAt),
          })}
        </span>
      </div>
      <div className="hint mt-1">{t("chat.compactionHint")}</div>

      <div className="mt-3 flex items-center gap-2 border-t border-[var(--border)] pt-2">
        <button className="btn ml-auto h-7 text-[9px]" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          className="btn btn-primary h-7 text-[9px]"
          disabled={saving || !draft.model.trim()}
          onClick={() => void save()}
        >
          {saving ? <Spinner size={10} /> : <Check size={10} />}
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

export function ChatComposer({
  disabled,
  reviewing,
  working,
  onSend,
}: {
  disabled: boolean;
  reviewing: boolean;
  working: boolean;
  onSend: (text: string) => void;
}) {
  const t = useT();
  const app = useJin((state) => state.app);
  const busy = useJin((state) => state.busy);
  const fileTree = useJin((state) => state.fileTree);
  const fileTreeLoading = useJin((state) => state.fileTreeLoading);
  const loadFileTree = useJin((state) => state.loadFileTree);
  const [text, setText] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [mention, setMention] = useState<Mention | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const settings = app?.settings;
  const provider = settings?.provider;
  const model = provider?.model ?? "";
  const effort = provider?.reasoningEffort ?? "auto";
  const contextWindow = provider?.contextWindow ?? 128_000;
  const compactionRatio = provider?.compactionRatio ?? 0.8;
  const used = app?.context.totalTokens ?? 0;
  const percent = contextWindow > 0 ? Math.min(100, Math.round((used / contextWindow) * 100)) : 0;
  const compactAt = Math.round(contextWindow * compactionRatio);
  const files = useMemo(() => flattenFiles(fileTree), [fileTree]);
  const matches = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.trim().toLowerCase();
    return files
      .filter(
        (file) =>
          !query ||
          file.path.toLowerCase().includes(query) ||
          file.name.toLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [files, mention]);

  useEffect(() => {
    if (mention && !fileTree && !fileTreeLoading) void loadFileTree();
  }, [fileTree, fileTreeLoading, loadFileTree, mention]);

  useEffect(() => {
    setActiveIndex(0);
  }, [mention?.query]);

  useEffect(() => {
    if (!mention) return;
    if (activeIndex >= matches.length) setActiveIndex(0);
  }, [activeIndex, matches.length, mention]);

  const syncMention = (value: string, caret: number | null): void => {
    const position = caret ?? value.length;
    const before = value.slice(0, position);
    const match = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!match) {
      setMention(null);
      return;
    }
    setMention({
      start: position - match[2].length - 1,
      end: position,
      query: match[2],
    });
  };

  const insertMention = (path: string): void => {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${path} ${text.slice(mention.end)}`;
    const caret = mention.start + path.length + 2;
    setText(next);
    setMention(null);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  const submit = (): void => {
    const request = text.trim();
    if (!request || disabled) return;
    setText("");
    setMention(null);
    setConfigOpen(false);
    onSend(request);
  };

  const placeholder = reviewing
    ? t("chat.placeholder.review")
    : working
      ? t("chat.placeholder.working")
      : app?.project
        ? t("chat.placeholder.project")
        : t("chat.placeholder.none");

  return (
    <div className="relative">
      <ComposerConfig open={configOpen} onClose={() => setConfigOpen(false)} />
      {mention ? (
        <div className="absolute right-0 bottom-full left-0 z-20 mb-1 overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] shadow-2xl">
          <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5 text-[8px] text-[var(--faint)]">
            <Sparkles size={9} className="text-[var(--violet)]" />
            {t("chat.mentionFiles")}
            <span className="ml-auto">{t("chat.mentionHint")}</span>
          </div>
          {fileTreeLoading && !fileTree ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[9px] text-[var(--faint)]">
              <Spinner size={11} /> {t("chat.mentionLoading")}
            </div>
          ) : matches.length === 0 ? (
            <div className="px-3 py-3 text-[9px] text-[var(--faint)]">{t("chat.mentionEmpty")}</div>
          ) : (
            <div className="max-h-[220px] overflow-y-auto py-1">
              {matches.map((file, index) => (
                <button
                  key={file.path}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left ${
                    index === activeIndex
                      ? "bg-[var(--accent-soft)] text-[var(--text)]"
                      : "text-[var(--muted)] hover:bg-[var(--control)]"
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertMention(file.path);
                  }}
                >
                  <FileCode2 size={11} className="shrink-0 text-[var(--accent)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[9.5px] font-semibold">{file.name}</span>
                    {file.directory ? (
                      <span className="font-mono-ui block truncate text-[8px] text-[var(--faint)]">
                        {file.directory}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div
        className={`rounded-xl border bg-[var(--control)] p-1.5 transition-colors ${
          disabled
            ? "border-[var(--border)] opacity-65"
            : "border-[var(--border)] focus-within:border-cyan-300/40"
        }`}
      >
        <div className="flex items-center gap-1.5 px-0.5 pb-1">
          <button
            className="flex min-w-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-soft)] px-1.5 py-1 text-[8.5px] text-[var(--muted)] transition-colors hover:bg-[var(--control)]"
            onClick={() => {
              setMention(null);
              setConfigOpen((open) => !open);
            }}
            title={t("chat.composerConfig")}
          >
            <Cpu size={9} className="shrink-0 text-[var(--accent)]" />
            <span className="font-mono-ui max-w-[110px] truncate">{model || t("chat.model")}</span>
            <span className="chip h-[15px] shrink-0 px-1 text-[7px]">{effortLabel(t, effort)}</span>
            <ChevronDown size={8} className="shrink-0 text-[var(--faint)]" />
          </button>
          <span className="ml-auto font-mono-ui text-[8px] text-[var(--faint)]">
            {t("chat.contextUsage", {
              used: formatCount(used),
              limit: formatCount(contextWindow),
              percent,
            })}
          </span>
        </div>
        <textarea
          ref={textareaRef}
          className="max-h-[150px] min-h-[54px] w-full resize-none border-0 bg-transparent px-1.5 py-1 text-[10.5px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--faint)]"
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            setText(value);
            syncMention(value, event.target.selectionStart);
          }}
          onKeyDown={(event) => {
            if (mention && matches.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => (index + 1) % matches.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                const choice = matches[activeIndex] ?? matches[0];
                if (choice) insertMention(choice.path);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMention(null);
                return;
              }
            }
            if (event.key === "Escape" && configOpen) {
              event.preventDefault();
              setConfigOpen(false);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-0.5 flex items-center gap-2 px-0.5">
          <div className="min-w-0 flex-1">
            <div className="relative h-1 overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className={`absolute inset-y-0 left-0 rounded-full ${
                  used >= compactAt ? "bg-[var(--warning)]" : "bg-[var(--accent)]"
                }`}
                style={{ width: `${percent}%` }}
              />
              <div
                className="absolute inset-y-0 w-px bg-[var(--faint)]"
                style={{ left: `${Math.round(compactionRatio * 100)}%` }}
              />
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[7.5px] text-[var(--faint)]">
              <span>{t("chat.context")}</span>
              <span>·</span>
              <span>
                {t("chat.contextCompact", {
                  ratio: Math.round(compactionRatio * 100),
                  tokens: formatCount(compactAt),
                })}
              </span>
            </div>
          </div>
          <CornerDownLeft size={9} className="shrink-0 text-[var(--faint)]" />
          <span className="max-w-[120px] truncate text-[8px] text-[var(--faint)]">
            {t("chat.enterHint")}
          </span>
          <button
            className="btn btn-primary ml-auto h-7 w-7 shrink-0 p-0"
            disabled={disabled || !text.trim()}
            onClick={submit}
            title={t("chat.send")}
            aria-label={t("chat.sendMessage")}
          >
            {busy ? <Spinner size={12} /> : <Send size={12} />}
          </button>
        </div>
      </div>
    </div>
  );
}
