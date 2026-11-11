import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  Cpu,
  Download,
  GitMerge,
  KeyRound,
  Layers3,
  Palette,
  Plug,
  RefreshCw,
  Search,
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
  Language,
  LspStatus,
  MarketplaceExtension,
  MarketplaceSearchResult,
  ProviderModel,
  ReasoningEffort,
  SettingsPatch,
  ThemeMode,
  UpdateState,
} from "../../shared/ipc";
import type { MessageKey, TranslationParams } from "../../shared/i18n";
import type { SettingsTab } from "../state/useJin";
import { useT } from "../lib/i18n";
import { copyText, formatCount } from "../lib/utils";
import { useJin } from "../state/useJin";
import { ModelField } from "./ModelField";
import { Modal, ModalHeader, SectionLabel, Spinner } from "./ui";

const TABS: Array<{ id: SettingsTab; label: MessageKey; icon: typeof Cpu }> = [
  { id: "general", label: "settings.tab.general", icon: SlidersHorizontal },
  { id: "provider", label: "settings.tab.provider", icon: Cpu },
  { id: "team", label: "settings.tab.team", icon: Users },
  { id: "tools", label: "settings.tab.tools", icon: Wrench },
];

type Draft = {
  language: Language;
  theme: ThemeMode;
  glass: GlassStrength;
  reduceMotion: boolean;
  providerKind: AppSettings["provider"]["kind"];
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  contextWindow: number;
  compactionRatio: number;
  inputPrice: number;
  outputPrice: number;
  semanticScan: boolean;
  temperature: number;
  maxTokens: number;
  userName: string;
  userEmail: string;
  updateAutoCheck: boolean;
  updateFeedUrl: string;
};

function draftFrom(settings: AppSettings): Draft {
  return {
    language: settings.language,
    theme: settings.theme,
    glass: settings.glass,
    reduceMotion: settings.ui.reduceMotion,
    providerKind: settings.provider.kind,
    baseUrl: settings.provider.baseUrl,
    model: settings.provider.model,
    reasoningEffort: settings.provider.reasoningEffort ?? "auto",
    contextWindow: settings.provider.contextWindow ?? 128_000,
    compactionRatio: settings.provider.compactionRatio ?? 0.8,
    inputPrice: settings.provider.inputPricePerMillion ?? 0,
    outputPrice: settings.provider.outputPricePerMillion ?? 0,
    semanticScan: settings.agent.semanticScan,
    temperature: settings.agent.temperature,
    maxTokens: settings.agent.maxTokens,
    userName: settings.identity.name,
    userEmail: settings.identity.email,
    updateAutoCheck: settings.updates.autoCheck,
    updateFeedUrl: settings.updates.feedUrl,
  };
}

function updateStatusText(
  update: UpdateState,
  t: (key: MessageKey, params?: TranslationParams) => string,
): string {
  switch (update.status) {
    case "checking":
      return t("settings.updateChecking");
    case "available":
      return t("settings.updateAvailable", {
        version: update.availableVersion ?? "?",
      });
    case "not-available":
      return t("settings.updateNotAvailable");
    case "downloading":
      return t("settings.updateDownloading", {
        percent: Math.round(update.percent ?? 0),
      });
    case "downloaded":
      return t("settings.updateDownloaded", {
        version: update.availableVersion ?? "?",
      });
    case "error":
      return t("settings.updateError", {
        message: update.message ?? "unknown",
      });
    case "disabled": {
      const reason = update.reason
        ? t(`settings.updateReason.${update.reason}` as MessageKey)
        : t("common.noData");
      return t("settings.updateDisabled", { reason });
    }
    default:
      return t("settings.updateCurrent", {
        version: update.currentVersion,
      });
  }
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
  const t = useT();
  const app = useJin((state) => state.app);
  const closeProject = useJin((state) => state.closeProject);
  const setSettingsOpen = useJin((state) => state.setSettingsOpen);
  const busy = useJin((state) => state.busy);
  const update = useJin((state) => state.update);
  const checkForUpdates = useJin((state) => state.checkForUpdates);
  const downloadUpdate = useJin((state) => state.downloadUpdate);
  const installUpdate = useJin((state) => state.installUpdate);
  const checking = update?.status === "checking" || update?.status === "downloading";

  return (
    <div className="space-y-6">
      <section>
        <SectionLabel>{t("settings.appearance")}</SectionLabel>
        <div className="mt-2">
          <div className="label">{t("settings.language")}</div>
          <div className="segmented w-full">
            {(["en", "zh"] as const).map((language) => (
              <button
                key={language}
                className={`flex-1 ${draft.language === language ? "active" : ""}`}
                onClick={() => setDraft({ language })}
              >
                {t(language === "en" ? "settings.language.en" : "settings.language.zh")}
              </button>
            ))}
          </div>
          <div className="hint mt-1">{t("settings.languageDetail")}</div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="label">{t("settings.theme")}</div>
            <div className="segmented w-full">
              {(["dark", "light", "system"] as const).map((theme) => (
                <button
                  key={theme}
                  className={`flex-1 capitalize ${draft.theme === theme ? "active" : ""}`}
                  onClick={() => setDraft({ theme })}
                >
                  {t(
                    theme === "dark"
                      ? "settings.theme.dark"
                      : theme === "light"
                        ? "settings.theme.light"
                        : "settings.theme.system",
                  )}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="label">{t("settings.glass")}</div>
            <div className="segmented w-full">
              {(["off", "subtle", "medium", "strong"] as const).map((glass) => (
                <button
                  key={glass}
                  className={`flex-1 capitalize ${draft.glass === glass ? "active" : ""}`}
                  onClick={() => setDraft({ glass })}
                >
                  {t(
                    glass === "off"
                      ? "settings.glass.off"
                      : glass === "subtle"
                        ? "settings.glass.subtle"
                        : glass === "medium"
                          ? "settings.glass.medium"
                          : "settings.glass.strong",
                  )}
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
            <span className="block text-[10.5px] font-semibold">{t("settings.reduceMotion")}</span>
            <span className="mt-0.5 block text-[9px] leading-relaxed text-[var(--faint)]">
              {t("settings.reduceMotionDetail")}
            </span>
          </span>
        </label>
      </section>

      <section>
        <SectionLabel>{t("settings.identity")}</SectionLabel>
        <p className="mt-1 text-[9.5px] leading-relaxed text-[var(--faint)]">
          {t("settings.identityDetail")}
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="label">{t("settings.name")}</div>
            <input
              className="field"
              value={draft.userName}
              onChange={(event) => setDraft({ userName: event.target.value })}
              placeholder={t("settings.namePlaceholder")}
            />
          </div>
          <div>
            <div className="label">{t("settings.email")}</div>
            <input
              className="field"
              value={draft.userEmail}
              onChange={(event) => setDraft({ userEmail: event.target.value })}
              placeholder={t("settings.emailPlaceholder")}
            />
          </div>
        </div>
        <div className="mt-2">
          <div className="label">{t("settings.actorId")}</div>
          <div className="font-mono-ui rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] px-2.5 py-2 text-[9px] text-[var(--faint)]">
            {settings.identity.actorId}
          </div>
        </div>
      </section>

      <section>
        <SectionLabel>{t("settings.currentProject")}</SectionLabel>
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
                {t("settings.filesScanned", { count: app.scan.files })}
              </span>
              <span className="chip h-[19px] text-[8px]">
                {t("settings.walRecordCount", { count: app.wal.records })}
              </span>
            </div>
            <button
              className="btn mt-3 h-7 text-[9px]"
              disabled={Boolean(busy)}
              onClick={() => {
                void closeProject();
                setSettingsOpen(false);
              }}
            >
              {t("settings.closeProject")}
            </button>
          </div>
        ) : (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-[9.5px] text-[var(--faint)]">
            {t("settings.noProject")}
          </div>
        )}
      </section>

      <section>
        <SectionLabel>{t("settings.data")}</SectionLabel>
        <div className="mt-2 grid gap-2 text-[9.5px] text-[var(--faint)]">
          <div className="flex items-center gap-2">
            <ShieldCheck size={11} className="text-[var(--success)]" />
            {t("settings.dataKeys")}
          </div>
          <div className="flex items-center gap-2">
            <BookOpen size={11} className="text-[var(--violet)]" />
            {t("settings.dataLedger")}
          </div>
        </div>
      </section>

      <section>
        <SectionLabel>{t("settings.updates")}</SectionLabel>
        <p className="mt-1 text-[9.5px] leading-relaxed text-[var(--faint)]">
          {t("settings.updatesDetail")}
        </p>
        <label className="mt-2 flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--border)] px-3 py-2.5">
          <input
            type="checkbox"
            className="mt-0.5 accent-cyan-300"
            checked={draft.updateAutoCheck}
            onChange={(event) => setDraft({ updateAutoCheck: event.target.checked })}
          />
          <span>
            <span className="block text-[10.5px] font-semibold">
              {t("settings.updateAutoCheck")}
            </span>
            <span className="mt-0.5 block text-[9px] leading-relaxed text-[var(--faint)]">
              {t("settings.updateAutoCheckDetail")}
            </span>
          </span>
        </label>
        <div className="mt-3">
          <div className="label">{t("settings.updateFeed")}</div>
          <input
            className="field"
            value={draft.updateFeedUrl}
            onChange={(event) => setDraft({ updateFeedUrl: event.target.value })}
            placeholder={t("settings.updateFeedPlaceholder")}
            spellCheck={false}
          />
          <div className="hint mt-1">{t("settings.updateFeedHint")}</div>
        </div>
        {update ? (
          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] px-3 py-2.5">
            <div className="flex items-start gap-2">
              <RefreshCw
                size={11}
                className={`mt-0.5 shrink-0 text-[var(--accent)] ${checking ? "animate-spin" : ""}`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[9.5px] leading-relaxed text-[var(--muted)]">
                  {updateStatusText(update, t)}
                </div>
                {update.status === "downloading" ? (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--border)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent)] transition-[width]"
                      style={{ width: `${Math.max(0, Math.min(100, update.percent ?? 0))}%` }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                className="btn h-7 text-[9px]"
                disabled={!update.canCheck || checking}
                onClick={() => void checkForUpdates()}
              >
                <RefreshCw size={10} />
                {t("settings.updateCheck")}
              </button>
              {update.canDownload ? (
                <button
                  className="btn btn-primary h-7 text-[9px]"
                  onClick={() => void downloadUpdate()}
                >
                  <Download size={10} />
                  {t("settings.updateDownload")}
                </button>
              ) : null}
              {update.canInstall ? (
                <button
                  className="btn btn-primary h-7 text-[9px]"
                  onClick={() => void installUpdate()}
                >
                  <Download size={10} />
                  {t("settings.updateInstall")}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
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
  const t = useT();
  const openai = draft.providerKind === "openai-compatible";
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsMessage, setModelsMessage] = useState<string | null>(null);
  const [logPath, setLogPath] = useState("");

  useEffect(() => {
    let cancelled = false;
    void window.jin
      .getLlmLogPath()
      .then((path) => {
        if (!cancelled) setLogPath(path);
      })
      .catch(() => {
        if (!cancelled) setLogPath("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadModels = useCallback(async (): Promise<void> => {
    if (draft.providerKind === "none" || !draft.baseUrl.trim()) {
      setModels([]);
      setModelsMessage(null);
      return;
    }
    setModelsLoading(true);
    setModelsMessage(null);
    try {
      const catalog = await window.jin.listModels({
        kind: draft.providerKind,
        baseUrl: draft.baseUrl.trim(),
        apiKey: clearKey ? null : apiKey.trim() ? apiKey : undefined,
      });
      setModels(catalog.models);
      setModelsMessage(catalog.warning ?? null);
    } catch (error) {
      setModels([]);
      setModelsMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setModelsLoading(false);
    }
  }, [apiKey, clearKey, draft.baseUrl, draft.providerKind]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadModels();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [loadModels]);

  const selectedModel = models.find((model) => model.id === draft.model);
  const efforts =
    selectedModel?.reasoningEfforts ?? (["auto", "low", "medium", "high"] as ReasoningEffort[]);
  const effortHint = selectedModel
    ? t(
        selectedModel.reasoningSource === "remote"
          ? "chat.effortRemote"
          : selectedModel.reasoningSource === "inferred"
            ? "chat.effortInferred"
            : "chat.effortDefault",
      )
    : t("chat.effortHint");

  return (
    <div className="space-y-6">
      <section>
        <SectionLabel>{t("settings.provider")}</SectionLabel>
        <p className="mt-1 text-[9.5px] leading-relaxed text-[var(--faint)]">
          {t("settings.providerDetail")}
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="label">{t("settings.kind")}</div>
            <select
              className="field"
              value={draft.providerKind}
              onChange={(event) =>
                setDraft({
                  providerKind: event.target.value as Draft["providerKind"],
                })
              }
            >
              <option value="none">{t("settings.kind.none")}</option>
              <option value="openai-compatible">{t("settings.kind.openai")}</option>
              <option value="ollama">{t("settings.kind.ollama")}</option>
            </select>
          </div>
          <div>
            <div className="label label-row">
              <span>{t("settings.model")}</span>
              {modelsLoading ? <Spinner size={9} /> : null}
            </div>
            <ModelField
              models={models}
              value={draft.model}
              loading={modelsLoading}
              disabled={draft.providerKind === "none"}
              onRefresh={() => void loadModels()}
              onChange={(next, found) =>
                setDraft({
                  model: next,
                  ...(found?.contextWindow ? { contextWindow: found.contextWindow } : {}),
                  ...(found && !found.reasoningEfforts.includes(draft.reasoningEffort)
                    ? { reasoningEffort: "auto" as ReasoningEffort }
                    : {}),
                })
              }
              hint={
                modelsMessage
                  ? modelsMessage
                  : models.length > 0
                    ? t("settings.modelsFound", { count: models.length })
                    : t("settings.modelsHint")
              }
            />
          </div>
        </div>
        <div className="mt-3">
          <div className="label">{t("settings.baseUrl")}</div>
          <input
            className="field font-mono-ui"
            value={draft.baseUrl}
            onChange={(event) => setDraft({ baseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
            disabled={draft.providerKind === "none"}
          />
          <div className="hint mt-1">{t("settings.baseUrlHint")}</div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="label">{t("chat.effort")}</div>
            <div className="segmented w-full">
              {efforts.map((effort) => (
                <button
                  key={effort}
                  className={`flex-1 capitalize ${
                    draft.reasoningEffort === effort ? "active" : ""
                  }`}
                  onClick={() => setDraft({ reasoningEffort: effort })}
                  disabled={draft.providerKind === "none"}
                >
                  {t(
                    effort === "auto"
                      ? "chat.effort.auto"
                      : effort === "low"
                        ? "chat.effort.low"
                        : effort === "medium"
                          ? "chat.effort.medium"
                          : "chat.effort.high",
                  )}
                </button>
              ))}
            </div>
            <div className="hint mt-1">{effortHint}</div>
          </div>
          <div>
            <div className="label">{t("chat.contextWindow")}</div>
            <input
              className="field font-mono-ui"
              type="number"
              min={1000}
              max={4_000_000}
              step={1000}
              value={draft.contextWindow}
              onChange={(event) =>
                setDraft({ contextWindow: Number(event.target.value) || 128_000 })
              }
              disabled={draft.providerKind === "none"}
            />
            <div className="hint mt-1">{t("chat.contextWindowHint")}</div>
          </div>
        </div>

        <div className="mt-3">
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
            onChange={(event) => setDraft({ compactionRatio: Number(event.target.value) / 100 })}
            className="w-full accent-cyan-300"
            disabled={draft.providerKind === "none"}
          />
          <div className="hint">{t("chat.compactionHint")}</div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="label">{t("settings.inputPrice")}</div>
            <input
              className="field font-mono-ui"
              type="number"
              min={0}
              step="0.01"
              value={draft.inputPrice}
              onChange={(event) => {
                const value = Number(event.target.value);
                setDraft({ inputPrice: Number.isFinite(value) ? Math.max(0, value) : 0 });
              }}
              disabled={draft.providerKind === "none"}
            />
          </div>
          <div>
            <div className="label">{t("settings.outputPrice")}</div>
            <input
              className="field font-mono-ui"
              type="number"
              min={0}
              step="0.01"
              value={draft.outputPrice}
              onChange={(event) => {
                const value = Number(event.target.value);
                setDraft({ outputPrice: Number.isFinite(value) ? Math.max(0, value) : 0 });
              }}
              disabled={draft.providerKind === "none"}
            />
          </div>
        </div>
        <div className="hint mt-1">{t("settings.priceHint")}</div>

        {openai ? (
          <div className="mt-3">
            <div className="label">
              {t("settings.apiKey")}{" "}
              {settings.provider.hasApiKey ? (
                <span className="normal-case tracking-normal text-[var(--success)]">
                  {t("settings.stored")}
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
                    ? t("settings.storedKeyPlaceholder")
                    : t("settings.apiKeyPlaceholder")
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
                  title={t("settings.deleteKeyTitle")}
                >
                  <Trash2 size={12} />
                  {clearKey ? t("settings.willDelete") : t("settings.clear")}
                </button>
              ) : null}
            </div>
            <div className="hint mt-1 flex items-center gap-1.5">
              <KeyRound size={9} />
              {t("settings.keyHint")}
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <SectionLabel>{t("settings.logs")}</SectionLabel>
        <p className="mt-1 text-[9.5px] leading-relaxed text-[var(--faint)]">
          {t("settings.logsHint")}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <button className="btn h-7 text-[9px]" onClick={() => void window.jin.openLlmLogFolder()}>
            <Terminal size={10} />
            {t("settings.openLogsFolder")}
          </button>
          <code className="min-w-0 flex-1 truncate font-mono-ui text-[9px] text-[var(--faint)]">
            {logPath || "…"}
          </code>
        </div>
      </section>

      <section>
        <SectionLabel>{t("settings.agent")}</SectionLabel>
        <div className="hint mt-1 flex items-start gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2.5">
          <Wrench size={10} className="mt-0.5 shrink-0" />
          <span>{t("settings.toolsRequired")}</span>
        </div>
        <label className="mt-2 flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--border)] px-3 py-2.5">
          <input
            type="checkbox"
            className="mt-0.5 accent-cyan-300"
            checked={draft.semanticScan}
            onChange={(event) => setDraft({ semanticScan: event.target.checked })}
          />
          <span>
            <span className="block text-[10.5px] font-semibold">{t("settings.semanticScan")}</span>
            <span className="mt-0.5 block text-[9px] leading-relaxed text-[var(--faint)]">
              {t("settings.semanticScanDetail")}
            </span>
          </span>
        </label>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="label label-row">
              <span>{t("settings.temperature")}</span>
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
              onChange={(event) => setDraft({ temperature: Number(event.target.value) })}
              className="w-full accent-cyan-300"
            />
            <div className="hint">{t("settings.temperatureHint")}</div>
          </div>
          <div>
            <div className="label">{t("settings.maxTokens")}</div>
            <input
              className="field"
              type="number"
              min={512}
              max={32000}
              step={256}
              value={draft.maxTokens}
              onChange={(event) => setDraft({ maxTokens: Number(event.target.value) || 8000 })}
            />
            <div className="hint">{t("settings.maxTokensHint")}</div>
          </div>
        </div>
      </section>

      {draft.providerKind !== "none" ? (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] p-2.5 text-[9px] leading-relaxed text-[var(--faint)]">
          <Sparkles size={11} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          {t("settings.providerPrivacy")}
        </div>
      ) : null}
    </div>
  );
}

function TeamTab() {
  const t = useT();
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
        <SectionLabel>{t("settings.teamDriver")}</SectionLabel>
        <p className="mt-1 text-[9.5px] leading-relaxed text-[var(--faint)]">
          {t("settings.teamDriverDetail")}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() => void installMergeDriver()}
          >
            <GitMerge size={13} />
            {t("settings.installDriver")}
          </button>
          <button className="btn" disabled={loading} onClick={() => void loadInstructions()}>
            {loading ? <Spinner size={12} /> : <BookOpen size={12} />}
            {t("settings.showSetup")}
          </button>
          {instructions ? (
            <button
              className="btn btn-ghost"
              onClick={async () => {
                const ok = await copyText(instructions);
                notify(
                  ok ? "success" : "error",
                  ok ? t("settings.instructionsCopied") : t("common.copyFailed"),
                );
              }}
            >
              <Copy size={12} />
              {t("common.copy")}
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
            {t("settings.gitattributes")}
          </div>
          <div className="inner-panel flex items-start gap-2 p-2.5">
            <Terminal size={11} className="mt-0.5 shrink-0 text-[var(--violet)]" />
            {t("settings.gitConfig")}
          </div>
        </div>
      </section>

      <section>
        <SectionLabel>{t("settings.currentLedger")}</SectionLabel>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <div className="inner-panel p-2.5">
            <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">
              {t("settings.ledger.records")}
            </div>
            <div className="font-mono-ui mt-0.5 text-[16px] font-bold">{app?.wal.records ?? 0}</div>
          </div>
          <div className="inner-panel p-2.5">
            <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">
              {t("settings.ledger.versions")}
            </div>
            <div className="font-mono-ui mt-0.5 text-[16px] font-bold">
              {app?.snapshot ? Object.keys(app.snapshot.versions).length : 0}
            </div>
          </div>
          <div className="inner-panel p-2.5">
            <div className="text-[8px] tracking-wide text-[var(--faint)] uppercase">
              {t("settings.ledger.conflicts")}
            </div>
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
                <strong className="text-[var(--danger)]">{conflict.code}</strong> {conflict.message}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2 text-[9px] text-[var(--success)]">
            <ShieldCheck size={11} /> {t("settings.noConflicts")}
          </div>
        )}
      </section>

      <section>
        <SectionLabel>{t("settings.collaboration")}</SectionLabel>
        <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] p-3 text-[9px] leading-relaxed text-[var(--faint)]">
          {t("settings.collaborationDetail")}
        </div>
      </section>
    </div>
  );
}

function ToolsTab() {
  const t = useT();
  const app = useJin((state) => state.app);
  const refreshTools = useJin((state) => state.refreshTools);
  const searchExtensions = useJin((state) => state.searchExtensions);
  const installLspExtension = useJin((state) => state.installLspExtension);
  const uninstallLspExtension = useJin((state) => state.uninstallLspExtension);
  const notify = useJin((state) => state.notify);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("language server");
  const [results, setResults] = useState<MarketplaceSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const autoSearch = useRef(false);
  const tools = app?.tools;

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    await refreshTools();
    setRefreshing(false);
  };

  const runSearch = useCallback(
    async (text: string): Promise<void> => {
      setSearching(true);
      const found = await searchExtensions(text, 12);
      setSearching(false);
      if (found) setResults(found);
    },
    [searchExtensions],
  );

  useEffect(() => {
    if (autoSearch.current) return;
    autoSearch.current = true;
    void runSearch("language server");
  }, [runSearch]);

  const updateInstalled = (
    id: string,
    installed: boolean,
    extension: MarketplaceExtension | null,
  ): void => {
    setResults((current) =>
      current
        ? {
            ...current,
            extensions: current.extensions.map((item) =>
              item.id === id
                ? {
                    ...item,
                    installed,
                    installedVersion: installed ? (extension?.version ?? item.version) : undefined,
                    server: installed ? (extension?.server ?? null) : null,
                  }
                : item,
            ),
          }
        : current,
    );
  };

  const install = async (extension: MarketplaceExtension): Promise<void> => {
    setInstalling(extension.id);
    const result = await installLspExtension(extension.id);
    setInstalling(null);
    if (result?.ok) updateInstalled(extension.id, true, result.extension);
  };

  const remove = async (extension: MarketplaceExtension): Promise<void> => {
    setInstalling(extension.id);
    const result = await uninstallLspExtension(extension.id);
    setInstalling(null);
    if (result?.ok) updateInstalled(extension.id, false, null);
  };

  const copy = async (text: string, label: string): Promise<void> => {
    const ok = await copyText(text);
    notify(ok ? "success" : "error", ok ? t("common.copied", { label }) : t("common.copyFailed"));
  };

  if (!tools)
    return <div className="text-[10px] text-[var(--faint)]">{t("settings.tools.noTools")}</div>;

  const statusLabel = (status: LspStatus["status"]): string =>
    t(
      status === "available"
        ? "settings.lsp.status.available"
        : status === "missing"
          ? "settings.lsp.status.missing"
          : "settings.lsp.status.unknown",
    );

  const serverDetail = (server: LspStatus): string => {
    if (server.source === "marketplace") {
      if (server.status === "missing") {
        return t("settings.lsp.detail.marketplaceMissing");
      }
      return t("settings.lsp.detail.marketplace", {
        extension: server.extensionId ?? server.id,
        version: server.version ? ` v${server.version}` : "",
      });
    }
    return server.status === "missing"
      ? t("settings.lsp.detail.pathMissing")
      : t("settings.lsp.detail.pathFound", { command: server.server });
  };

  const missing = (app?.lsp ?? []).filter((server) => server.status === "missing");
  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center gap-2">
          <SectionLabel>{t("settings.marketplace")}</SectionLabel>
          <span className="chip ml-auto h-[18px] px-1.5 text-[8px]">
            {results ? results.total : 0}
          </span>
        </div>
        <p className="mt-1 text-[9px] leading-relaxed text-[var(--faint)]">
          {t("settings.marketplaceDetail")}
        </p>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch(query);
          }}
        >
          <input
            className="field"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("settings.marketplace.placeholder")}
          />
          <button
            className="btn h-[34px] shrink-0 px-2.5 text-[9px]"
            type="submit"
            disabled={searching}
          >
            {searching ? <Spinner size={10} /> : <Search size={10} />}
            {t("settings.marketplace.search")}
          </button>
        </form>
        <div className="hint mt-1">{t("settings.marketplace.urlHint")}</div>

        {searching && !results ? (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] px-3 py-3 text-[9px] text-[var(--faint)]">
            <Spinner size={11} /> {t("settings.marketplace.searching")}
          </div>
        ) : !results ? (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-[9.5px] text-[var(--faint)]">
            {t("settings.marketplace.start")}
          </div>
        ) : results.extensions.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-[9.5px] text-[var(--faint)]">
            {t("settings.marketplace.empty")}
          </div>
        ) : (
          <div className="mt-2 max-h-[360px] space-y-1.5 overflow-y-auto pr-1">
            {results.extensions.map((extension) => {
              const installed =
                extension.installed && extension.installedVersion === extension.version;
              const update =
                extension.installed && extension.installedVersion !== extension.version;
              return (
                <div key={extension.id} className="inner-panel p-2.5">
                  <div className="flex items-start gap-2">
                    {extension.iconUrl ? (
                      <img
                        src={extension.iconUrl}
                        alt=""
                        className="mt-0.5 h-6 w-6 shrink-0 rounded-md border border-[var(--border)] object-contain"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--panel-soft)] text-[var(--violet)]">
                        <Plug size={11} />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[10px] font-semibold">
                          {extension.displayName}
                        </span>
                        {extension.verified ? (
                          <ShieldCheck size={9} className="shrink-0 text-[var(--success)]" />
                        ) : null}
                        <span className="font-mono-ui ml-auto shrink-0 text-[8px] text-[var(--faint)]">
                          v{extension.version}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[8px] text-[var(--faint)]">
                        <span className="font-mono-ui">{extension.id}</span>
                        <span>·</span>
                        <span>
                          {t("settings.marketplace.installs", {
                            count: formatCount(extension.installs),
                          })}
                        </span>
                        {extension.rating > 0 ? (
                          <>
                            <span>·</span>
                            <span>★ {extension.rating.toFixed(1)}</span>
                          </>
                        ) : null}
                      </div>
                      <div className="mt-1 text-[8.5px] leading-relaxed text-[var(--muted)]">
                        {extension.description}
                      </div>
                      {extension.server ? (
                        <div className="font-mono-ui mt-1 truncate text-[8px] text-[var(--success)]">
                          {t("settings.marketplace.server", {
                            path: extension.server,
                          })}
                        </div>
                      ) : extension.installed ? (
                        <div className="mt-1 text-[8px] text-[var(--warning)]">
                          {t("settings.marketplace.noServerShort")}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {installed ? (
                        <span className="chip chip-success h-[18px] px-1.5 text-[8px]">
                          {t("settings.marketplace.installedLabel")}
                        </span>
                      ) : (
                        <button
                          className="btn h-6 px-2 text-[8px]"
                          disabled={installing === extension.id}
                          onClick={() => void install(extension)}
                        >
                          {installing === extension.id ? (
                            <Spinner size={9} />
                          ) : (
                            <Download size={9} />
                          )}
                          {update
                            ? t("settings.marketplace.update")
                            : t("settings.marketplace.install")}
                        </button>
                      )}
                      {extension.installed ? (
                        <button
                          className="icon-btn h-6 w-6"
                          title={t("settings.marketplace.uninstall")}
                          disabled={installing === extension.id}
                          onClick={() => void remove(extension)}
                        >
                          <Trash2 size={9} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="hint mt-1">{t("settings.marketplace.restartHint")}</div>
      </section>

      <section>
        <div className="flex items-center gap-2">
          <SectionLabel>{t("settings.lsp")}</SectionLabel>
          <span className="chip ml-auto h-[18px] px-1.5 text-[8px]">
            {t("settings.lsp.missing", { count: missing.length })}
          </span>
          <button className="btn h-7 px-2 text-[9px]" onClick={() => void refresh()}>
            {refreshing ? <Spinner size={10} /> : <RefreshCw size={10} />}
            {t("common.refresh")}
          </button>
        </div>
        <p className="mt-1 text-[9px] leading-relaxed text-[var(--faint)]">
          {t("settings.lspDetail")}
        </p>

        {(app?.lsp ?? []).length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-[9.5px] text-[var(--faint)]">
            {t("settings.lsp.none")}
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
                  {server.source ? (
                    <span className="chip h-[18px] shrink-0 px-1.5 text-[8px]">
                      {t(
                        server.source === "marketplace"
                          ? "settings.lsp.source.marketplace"
                          : "settings.lsp.source.path",
                      )}
                    </span>
                  ) : null}
                  <span
                    className={`chip ml-auto h-[18px] px-1.5 text-[8px] ${
                      server.status === "missing" ? "chip-warning" : "chip-success"
                    }`}
                  >
                    {statusLabel(server.status)}
                  </span>
                </div>
                <div className="mt-1 pl-4 text-[8.5px] leading-relaxed text-[var(--faint)]">
                  {serverDetail(server)}
                </div>
                {server.status === "missing" ? (
                  <div className="mt-1.5 flex items-start gap-1.5 pl-4">
                    <AlertTriangle size={9} className="mt-0.5 shrink-0 text-[var(--warning)]" />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono-ui text-[8.5px] leading-relaxed text-[var(--muted)]">
                        {server.installHint}
                      </div>
                    </div>
                    {server.source !== "marketplace" ? (
                      <button
                        className="icon-btn h-6 w-6 shrink-0"
                        onClick={() => void copy(server.installHint, t("settings.installCommand"))}
                        title={t("settings.installCommand")}
                      >
                        <Copy size={10} />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2">
          <SectionLabel>{t("settings.skills")}</SectionLabel>
          <span className="chip ml-auto h-[18px] px-1.5 text-[8px]">{tools.skills.length}</span>
        </div>
        <p className="mt-1 text-[9px] leading-relaxed text-[var(--faint)]">
          {t("settings.skillsDetail")}
        </p>
        {tools.skills.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-[9.5px] text-[var(--faint)]">
            {t("settings.skills.none")}
          </div>
        ) : (
          <div className="mt-2 space-y-1.5">
            {tools.skills.map((skill) => (
              <div key={`${skill.scope}:${skill.path}`} className="inner-panel p-2.5">
                <div className="flex items-center gap-2">
                  <Sparkles size={11} className="shrink-0 text-[var(--violet)]" />
                  <span className="text-[10px] font-semibold">{skill.name}</span>
                  <span className="chip ml-auto h-[18px] px-1.5 text-[8px]">{skill.scope}</span>
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
          <SectionLabel>{t("settings.mcp")}</SectionLabel>
          <span className="chip ml-auto h-[18px] px-1.5 text-[8px]">{tools.mcpServers.length}</span>
        </div>
        <p className="mt-1 text-[9px] leading-relaxed text-[var(--faint)]">
          {t("settings.mcpDetail")}
        </p>
        {tools.mcpServers.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-[9.5px] text-[var(--faint)]">
            {t("settings.mcp.none")}
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
        <SectionLabel>{t("settings.builtinTools")}</SectionLabel>
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
        {t("settings.toolAudit")}
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const t = useT();
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
      setValidation(t("settings.validation.baseUrl"));
      setTab("provider");
      return;
    }
    if (draft.updateFeedUrl.trim() && !/^https?:\/\//i.test(draft.updateFeedUrl.trim())) {
      setValidation(t("settings.validation.updateFeed"));
      setTab("general");
      return;
    }
    const patch: SettingsPatch = {
      language: draft.language,
      theme: draft.theme,
      glass: draft.glass,
      reduceMotion: draft.reduceMotion,
      providerKind: draft.providerKind,
      providerBaseUrl: draft.baseUrl.trim(),
      providerModel: draft.model.trim(),
      providerReasoningEffort: draft.reasoningEffort,
      providerContextWindow: Math.max(
        1_000,
        Math.round(Number.isFinite(draft.contextWindow) ? draft.contextWindow : 128_000),
      ),
      providerCompactionRatio: draft.compactionRatio,
      providerInputPrice: draft.inputPrice,
      providerOutputPrice: draft.outputPrice,
      semanticScan: draft.semanticScan,
      temperature: draft.temperature,
      maxTokens: draft.maxTokens,
      userName: draft.userName,
      userEmail: draft.userEmail,
      updateAutoCheck: draft.updateAutoCheck,
      updateFeedUrl: draft.updateFeedUrl.trim(),
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
      label={t("settings.title")}
    >
      <ModalHeader
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
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
              {t(item.label)}
            </button>
          ))}
          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] p-2 text-[8.5px] leading-relaxed text-[var(--faint)]">
            <div className="flex items-center gap-1.5 font-semibold text-[var(--muted)]">
              <Palette size={10} /> {t("settings.glassNoteTitle")}
            </div>
            <div className="mt-1">{t("settings.glassNote")}</div>
          </div>
          <div className="mt-2 flex items-center gap-1.5 px-1 text-[8px] text-[var(--faint)]">
            <User size={9} />
            <span className="truncate">{settings?.identity.name ?? "Jin user"}</span>
          </div>
        </nav>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {!draft || !settings ? (
            <div className="flex h-full items-center justify-center text-[10px] text-[var(--faint)]">
              <Spinner size={13} /> {t("settings.loading")}
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
          {t("settings.storage")}
        </div>
        <button className="btn ml-auto h-8" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </button>
        <button
          className="btn btn-primary h-8 px-4"
          onClick={() => void save()}
          disabled={!draft || Boolean(busy)}
        >
          {t("settings.save")}
        </button>
      </div>
    </Modal>
  );
}
