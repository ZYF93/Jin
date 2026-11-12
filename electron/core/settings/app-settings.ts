import { hostname, userInfo } from "node:os";
import { safeStorage } from "electron";
import { isLanguage } from "../../../shared/i18n";
import { isProviderConfigured } from "../../../shared/provider";
import type {
  AppSettings,
  Language,
  ProviderSettings,
  ReasoningEffort,
  SettingsPatch,
  ThemeMode,
  GlassStrength,
} from "../../../shared/ipc";
import { deleteSetting, getSetting, setSetting, type AppDatabase } from "../db/app-db";
import { ulid } from "../ids/ulid";

const SETTINGS_KEY = "app.settings.v1";
const API_KEY = "app.provider.apiKey.v1";

interface StoredProvider {
  kind: ProviderSettings["kind"];
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  contextWindow: number;
  compactionRatio: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
}

interface StoredSettings {
  language: Language;
  theme: ThemeMode;
  glass: GlassStrength;
  provider: StoredProvider;
  agent: AppSettings["agent"];
  identity: AppSettings["identity"];
  ui: AppSettings["ui"];
  updates: AppSettings["updates"];
}

const THEMES: ReadonlySet<ThemeMode> = new Set(["dark", "light", "system"]);
const GLASS: ReadonlySet<GlassStrength> = new Set(["off", "subtle", "medium", "strong"]);
const PROVIDER_KINDS: ReadonlySet<ProviderSettings["kind"]> = new Set([
  "none",
  "openai-compatible",
  "openai-responses",
  "anthropic",
  "gemini",
  "ollama",
]);
const REASONING_EFFORTS: ReadonlySet<ReasoningEffort> = new Set(["auto", "low", "medium", "high"]);
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_COMPACTION_RATIO = 0.8;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function currentUserName(): string {
  try {
    return userInfo().username || "Jin user";
  } catch {
    return "Jin user";
  }
}

function defaults(): StoredSettings {
  return {
    language: "en",
    theme: "dark",
    glass: "subtle",
    provider: {
      kind: "none",
      baseUrl: "",
      model: "",
      reasoningEffort: "auto",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      compactionRatio: DEFAULT_COMPACTION_RATIO,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
    },
    agent: {
      semanticScan: true,
      temperature: 0.2,
      maxTokens: 8000,
    },
    identity: {
      actorId: `user:${currentUserName()}:${ulid()}`,
      name: currentUserName(),
      email: "",
    },
    ui: {
      reduceMotion: false,
    },
    updates: {
      autoCheck: true,
      feedUrl: "",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(raw: unknown): StoredSettings {
  const fallback = defaults();
  if (!isRecord(raw)) return fallback;
  const provider = isRecord(raw.provider) ? raw.provider : {};
  const agent = isRecord(raw.agent) ? raw.agent : {};
  const identity = isRecord(raw.identity) ? raw.identity : {};
  const ui = isRecord(raw.ui) ? raw.ui : {};
  const updates = isRecord(raw.updates) ? raw.updates : {};
  const theme = raw.theme;
  const glass = raw.glass;
  const kind = provider.kind;

  return {
    language: isLanguage(raw.language) ? raw.language : fallback.language,
    theme: THEMES.has(theme as ThemeMode) ? (theme as ThemeMode) : fallback.theme,
    glass: GLASS.has(glass as GlassStrength) ? (glass as GlassStrength) : fallback.glass,
    provider: {
      kind: PROVIDER_KINDS.has(kind as ProviderSettings["kind"])
        ? (kind as ProviderSettings["kind"])
        : fallback.provider.kind,
      baseUrl:
        typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : fallback.provider.baseUrl,
      model: typeof provider.model === "string" ? provider.model.trim() : fallback.provider.model,
      reasoningEffort: REASONING_EFFORTS.has(provider.reasoningEffort as ReasoningEffort)
        ? (provider.reasoningEffort as ReasoningEffort)
        : fallback.provider.reasoningEffort,
      contextWindow: Math.round(
        clamp(
          typeof provider.contextWindow === "number"
            ? provider.contextWindow
            : fallback.provider.contextWindow,
          1_000,
          4_000_000,
          fallback.provider.contextWindow,
        ),
      ),
      compactionRatio: clamp(
        typeof provider.compactionRatio === "number"
          ? provider.compactionRatio
          : fallback.provider.compactionRatio,
        0.1,
        1,
        fallback.provider.compactionRatio,
      ),
      inputPricePerMillion: clamp(
        typeof provider.inputPricePerMillion === "number"
          ? provider.inputPricePerMillion
          : fallback.provider.inputPricePerMillion,
        0,
        10_000,
        fallback.provider.inputPricePerMillion,
      ),
      outputPricePerMillion: clamp(
        typeof provider.outputPricePerMillion === "number"
          ? provider.outputPricePerMillion
          : fallback.provider.outputPricePerMillion,
        0,
        10_000,
        fallback.provider.outputPricePerMillion,
      ),
    },
    agent: {
      semanticScan:
        typeof agent.semanticScan === "boolean" ? agent.semanticScan : fallback.agent.semanticScan,
      temperature: clamp(
        typeof agent.temperature === "number" ? agent.temperature : fallback.agent.temperature,
        0,
        2,
        fallback.agent.temperature,
      ),
      maxTokens: Math.round(
        clamp(
          typeof agent.maxTokens === "number" ? agent.maxTokens : fallback.agent.maxTokens,
          512,
          32000,
          fallback.agent.maxTokens,
        ),
      ),
    },
    identity: {
      actorId:
        typeof identity.actorId === "string" && identity.actorId
          ? identity.actorId
          : fallback.identity.actorId,
      name:
        typeof identity.name === "string" && identity.name.trim()
          ? identity.name.trim()
          : fallback.identity.name,
      email: typeof identity.email === "string" ? identity.email.trim() : "",
    },
    ui: {
      reduceMotion:
        typeof ui.reduceMotion === "boolean" ? ui.reduceMotion : fallback.ui.reduceMotion,
    },
    updates: {
      autoCheck:
        typeof updates.autoCheck === "boolean" ? updates.autoCheck : fallback.updates.autoCheck,
      feedUrl: typeof updates.feedUrl === "string" ? updates.feedUrl.trim() : "",
    },
  };
}

function encodeSecret(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(value).toString("base64")}`;
  }
  return `b64:${Buffer.from(value, "utf8").toString("base64")}`;
}

function decodeSecret(value: string): string | null {
  try {
    if (value.startsWith("enc:")) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
    }
    if (value.startsWith("b64:")) {
      return Buffer.from(value.slice(4), "base64").toString("utf8");
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Global settings live in Electron userData. The API key is never exposed to
 * the renderer: `get()` reports only whether one exists, and the agent reads it
 * through `getProviderApiKey()` in the main process.
 */
export class SettingsStore {
  constructor(private readonly app: AppDatabase) {}

  private readRaw(): StoredSettings {
    const text = getSetting(this.app, SETTINGS_KEY);
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const settings = normalize(parsed);
    if (!text) this.writeRaw(settings);
    return settings;
  }

  private writeRaw(settings: StoredSettings): void {
    setSetting(this.app, SETTINGS_KEY, JSON.stringify(settings));
  }

  get(): AppSettings {
    const raw = this.readRaw();
    return {
      language: raw.language,
      theme: raw.theme,
      glass: raw.glass,
      provider: {
        ...raw.provider,
        hasApiKey: Boolean(getSetting(this.app, API_KEY)),
      },
      agent: raw.agent,
      identity: raw.identity,
      ui: raw.ui,
      updates: {
        autoCheck: raw.updates.autoCheck,
        feedUrl: raw.updates.feedUrl,
      },
    };
  }

  getProviderApiKey(): string | null {
    const stored = getSetting(this.app, API_KEY);
    return stored ? decodeSecret(stored) : null;
  }

  isAgentConfigured(): boolean {
    return isProviderConfigured(this.get().provider);
  }

  save(patch: SettingsPatch): AppSettings {
    const raw = this.readRaw();

    if (isLanguage(patch.language)) raw.language = patch.language;
    if (patch.theme && THEMES.has(patch.theme)) raw.theme = patch.theme;
    if (patch.glass && GLASS.has(patch.glass)) raw.glass = patch.glass;
    if (patch.providerKind && PROVIDER_KINDS.has(patch.providerKind)) {
      raw.provider.kind = patch.providerKind;
    }
    if (typeof patch.providerBaseUrl === "string") {
      raw.provider.baseUrl = patch.providerBaseUrl.trim().replace(/\/+$/, "");
    }
    if (typeof patch.providerModel === "string") {
      raw.provider.model = patch.providerModel.trim();
    }
    if (patch.providerReasoningEffort && REASONING_EFFORTS.has(patch.providerReasoningEffort)) {
      raw.provider.reasoningEffort = patch.providerReasoningEffort;
    }
    if (typeof patch.providerContextWindow === "number") {
      raw.provider.contextWindow = Math.round(
        clamp(patch.providerContextWindow, 1_000, 4_000_000, raw.provider.contextWindow),
      );
    }
    if (typeof patch.providerCompactionRatio === "number") {
      raw.provider.compactionRatio = clamp(
        patch.providerCompactionRatio,
        0.1,
        1,
        raw.provider.compactionRatio,
      );
    }
    if (typeof patch.providerInputPrice === "number") {
      raw.provider.inputPricePerMillion = clamp(
        patch.providerInputPrice,
        0,
        10_000,
        raw.provider.inputPricePerMillion,
      );
    }
    if (typeof patch.providerOutputPrice === "number") {
      raw.provider.outputPricePerMillion = clamp(
        patch.providerOutputPrice,
        0,
        10_000,
        raw.provider.outputPricePerMillion,
      );
    }
    if (typeof patch.semanticScan === "boolean") {
      raw.agent.semanticScan = patch.semanticScan;
    }
    if (typeof patch.temperature === "number") {
      raw.agent.temperature = clamp(patch.temperature, 0, 2, raw.agent.temperature);
    }
    if (typeof patch.maxTokens === "number") {
      raw.agent.maxTokens = Math.round(clamp(patch.maxTokens, 512, 32000, raw.agent.maxTokens));
    }
    if (typeof patch.userName === "string" && patch.userName.trim()) {
      raw.identity.name = patch.userName.trim();
    }
    if (typeof patch.userEmail === "string") {
      raw.identity.email = patch.userEmail.trim();
    }
    if (typeof patch.reduceMotion === "boolean") {
      raw.ui.reduceMotion = patch.reduceMotion;
    }
    if (typeof patch.updateAutoCheck === "boolean") {
      raw.updates.autoCheck = patch.updateAutoCheck;
    }
    if (typeof patch.updateFeedUrl === "string") {
      raw.updates.feedUrl = patch.updateFeedUrl.trim();
    }
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === null || patch.apiKey.trim() === "") {
        deleteSetting(this.app, API_KEY);
      } else {
        setSetting(this.app, API_KEY, encodeSecret(patch.apiKey.trim()));
      }
    }

    this.writeRaw(raw);
    return this.get();
  }

  /** Used only for provider calls. Never return this value through IPC. */
  providerConfig(): {
    kind: ProviderSettings["kind"];
    baseUrl: string;
    model: string;
    apiKey: string | null;
    reasoningEffort: ReasoningEffort;
    contextWindow: number;
    compactionRatio: number;
    inputPricePerMillion: number;
    outputPricePerMillion: number;
  } {
    const settings = this.get();
    return {
      kind: settings.provider.kind,
      baseUrl: settings.provider.baseUrl,
      model: settings.provider.model,
      apiKey: this.getProviderApiKey(),
      reasoningEffort: settings.provider.reasoningEffort ?? "auto",
      contextWindow: settings.provider.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      compactionRatio: settings.provider.compactionRatio ?? DEFAULT_COMPACTION_RATIO,
      inputPricePerMillion: settings.provider.inputPricePerMillion ?? 0,
      outputPricePerMillion: settings.provider.outputPricePerMillion ?? 0,
    };
  }

  hostLabel(): string {
    return hostname();
  }
}
