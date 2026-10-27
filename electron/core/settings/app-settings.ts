import { hostname, userInfo } from "node:os";
import { safeStorage } from "electron";
import type {
  AppSettings,
  ProviderSettings,
  SettingsPatch,
  ThemeMode,
  GlassStrength,
} from "../../../shared/ipc";
import {
  deleteSetting,
  getSetting,
  setSetting,
  type AppDatabase,
} from "../db/app-db";
import { ulid } from "../ids/ulid";

const SETTINGS_KEY = "app.settings.v1";
const API_KEY = "app.provider.apiKey.v1";

interface StoredProvider {
  kind: ProviderSettings["kind"];
  baseUrl: string;
  model: string;
}

interface StoredSettings {
  theme: ThemeMode;
  glass: GlassStrength;
  provider: StoredProvider;
  agent: AppSettings["agent"];
  identity: AppSettings["identity"];
  ui: AppSettings["ui"];
}

const THEMES: ReadonlySet<ThemeMode> = new Set(["dark", "light", "system"]);
const GLASS: ReadonlySet<GlassStrength> = new Set([
  "off",
  "subtle",
  "medium",
  "strong",
]);
const PROVIDER_KINDS: ReadonlySet<ProviderSettings["kind"]> = new Set([
  "none",
  "openai-compatible",
  "ollama",
]);

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
    theme: "dark",
    glass: "subtle",
    provider: {
      kind: "none",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    },
    agent: {
      autoImplement: true,
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
  const theme = raw.theme;
  const glass = raw.glass;
  const kind = provider.kind;

  return {
    theme: THEMES.has(theme as ThemeMode) ? (theme as ThemeMode) : fallback.theme,
    glass: GLASS.has(glass as GlassStrength)
      ? (glass as GlassStrength)
      : fallback.glass,
    provider: {
      kind: PROVIDER_KINDS.has(kind as ProviderSettings["kind"])
        ? (kind as ProviderSettings["kind"])
        : fallback.provider.kind,
      baseUrl:
        typeof provider.baseUrl === "string" && provider.baseUrl.trim()
          ? provider.baseUrl.trim()
          : fallback.provider.baseUrl,
      model:
        typeof provider.model === "string" && provider.model.trim()
          ? provider.model.trim()
          : fallback.provider.model,
    },
    agent: {
      autoImplement:
        typeof agent.autoImplement === "boolean"
          ? agent.autoImplement
          : fallback.agent.autoImplement,
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
        typeof ui.reduceMotion === "boolean"
          ? ui.reduceMotion
          : fallback.ui.reduceMotion,
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
      theme: raw.theme,
      glass: raw.glass,
      provider: {
        ...raw.provider,
        hasApiKey: Boolean(getSetting(this.app, API_KEY)),
      },
      agent: raw.agent,
      identity: raw.identity,
      ui: raw.ui,
    };
  }

  getProviderApiKey(): string | null {
    const stored = getSetting(this.app, API_KEY);
    return stored ? decodeSecret(stored) : null;
  }

  isAgentConfigured(): boolean {
    const settings = this.get();
    if (settings.provider.kind === "none") return false;
    if (settings.provider.kind === "ollama") return true;
    return Boolean(this.getProviderApiKey());
  }

  save(patch: SettingsPatch): AppSettings {
    const raw = this.readRaw();

    if (patch.theme && THEMES.has(patch.theme)) raw.theme = patch.theme;
    if (patch.glass && GLASS.has(patch.glass)) raw.glass = patch.glass;
    if (patch.providerKind && PROVIDER_KINDS.has(patch.providerKind)) {
      raw.provider.kind = patch.providerKind;
    }
    if (typeof patch.providerBaseUrl === "string" && patch.providerBaseUrl.trim()) {
      raw.provider.baseUrl = patch.providerBaseUrl.trim().replace(/\/+$/, "");
    }
    if (typeof patch.providerModel === "string" && patch.providerModel.trim()) {
      raw.provider.model = patch.providerModel.trim();
    }
    if (typeof patch.autoImplement === "boolean") {
      raw.agent.autoImplement = patch.autoImplement;
    }
    if (typeof patch.temperature === "number") {
      raw.agent.temperature = clamp(patch.temperature, 0, 2, raw.agent.temperature);
    }
    if (typeof patch.maxTokens === "number") {
      raw.agent.maxTokens = Math.round(
        clamp(patch.maxTokens, 512, 32000, raw.agent.maxTokens),
      );
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
  } {
    const settings = this.get();
    return {
      kind: settings.provider.kind,
      baseUrl: settings.provider.baseUrl,
      model: settings.provider.model,
      apiKey: this.getProviderApiKey(),
    };
  }

  hostLabel(): string {
    return hostname();
  }
}
