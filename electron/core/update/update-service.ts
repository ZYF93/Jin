import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  UpdateReason,
  UpdateState,
  UpdateStatus,
} from "../../../shared/ipc";

/** Minimal surface of electron-updater used by Jin. */
export interface UpdateAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  forceDevUpdateConfig: boolean;
  updateConfigPath: string | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  setFeedURL(options: { provider: "generic"; url: string }): void;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  packaged: boolean;
  platform?: NodeJS.Platform;
  /** Feed from app settings. */
  feedUrl?: string;
  /** Explicit override, normally JIN_UPDATE_FEED_URL. */
  envFeedUrl?: string;
  autoCheck?: boolean;
  /** Location for the dev-app-update.yml generated in development. */
  devConfigPath?: string;
  loadUpdater?: () => Promise<UpdateAdapter>;
  onState?: (state: UpdateState) => void;
  now?: () => Date;
}

const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "win32",
  "darwin",
  "linux",
]);

/**
 * Normalize an update feed. Only HTTP(S) is accepted; empty input means "use
 * the app-update.yml bundled by electron-builder".
 */
export function normalizeFeedUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isReason(value: unknown): value is Exclude<UpdateReason, null> {
  return (
    value === "development" ||
    value === "no-feed" ||
    value === "unsupported" ||
    value === "module-missing"
  );
}

/** Build the dev config electron-updater needs when forced on in development. */
export function devUpdateConfig(feedUrl: string): string {
  return [
    "provider: generic",
    `url: ${JSON.stringify(feedUrl)}`,
    "updaterCacheDirName: jin-updater",
    "",
  ].join("\n");
}

/**
 * Cross-platform update service around electron-updater. The renderer only
 * sees `UpdateState`; the updater module is loaded lazily and every failure is
 * converted into a visible state instead of crashing the main process.
 */
export class UpdateService {
  private readonly options: UpdateServiceOptions;
  private readonly platform: NodeJS.Platform;
  private updater: UpdateAdapter | null = null;
  private loading: Promise<UpdateAdapter | null> | null = null;
  private feedUrl: string | null;
  private autoCheck: boolean;
  private state: UpdateState;

  constructor(options: UpdateServiceOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.feedUrl =
      normalizeFeedUrl(options.envFeedUrl) ??
      normalizeFeedUrl(options.feedUrl);
    this.autoCheck = options.autoCheck ?? true;
    this.state = this.initialState();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private disabled(
    reason: Exclude<UpdateReason, null>,
    message: string | null = null,
  ): UpdateState {
    return {
      status: "disabled",
      currentVersion: this.options.currentVersion,
      availableVersion: null,
      percent: null,
      bytesPerSecond: null,
      transferred: null,
      total: null,
      checkedAt: null,
      message,
      reason,
      canCheck: false,
      canDownload: false,
      canInstall: false,
      feedUrl: this.feedUrl,
    };
  }

  private initialState(): UpdateState {
    if (!SUPPORTED_PLATFORMS.has(this.platform)) {
      return this.disabled("unsupported");
    }
    if (!this.options.packaged && !this.feedUrl) {
      return this.disabled(
        "development",
        "Set an update feed to test automatic updates from a development build.",
      );
    }
    return {
      status: "idle",
      currentVersion: this.options.currentVersion,
      availableVersion: null,
      percent: null,
      bytesPerSecond: null,
      transferred: null,
      total: null,
      checkedAt: null,
      message: null,
      reason: null,
      canCheck: true,
      canDownload: false,
      canInstall: false,
      feedUrl: this.feedUrl,
    };
  }

  getState(): UpdateState {
    return this.state;
  }

  get autoCheckEnabled(): boolean {
    return this.autoCheck;
  }

  private publish(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch };
    this.options.onState?.(this.state);
    return this.state;
  }

  private busy(): boolean {
    return (
      this.state.status === "checking" || this.state.status === "downloading"
    );
  }

  private setStatus(
    status: UpdateStatus,
    patch: Partial<UpdateState> = {},
  ): UpdateState {
    return this.publish({
      status,
      canCheck: status !== "checking" && status !== "downloading",
      canDownload: status === "available",
      canInstall: status === "downloaded",
      ...patch,
    });
  }

  /** Update settings without recreating the window. */
  configure(options: { autoCheck: boolean; feedUrl: string }): UpdateState {
    this.autoCheck = options.autoCheck;
    const next = normalizeFeedUrl(options.feedUrl);
    if (next === this.feedUrl) return this.state;
    this.feedUrl = next;
    this.applyFeed();
    if (!this.busy()) {
      this.state = this.initialState();
      this.options.onState?.(this.state);
    }
    return this.state;
  }

  private applyFeed(): void {
    if (!this.updater) return;
    if (this.feedUrl) {
      this.updater.setFeedURL({ provider: "generic", url: this.feedUrl });
    }
    this.writeDevConfig();
  }

  private writeDevConfig(): void {
    if (this.options.packaged || !this.feedUrl || !this.options.devConfigPath) {
      return;
    }
    try {
      mkdirSync(dirname(this.options.devConfigPath), { recursive: true });
      writeFileSync(
        this.options.devConfigPath,
        devUpdateConfig(this.feedUrl),
        "utf8",
      );
      this.updater!.updateConfigPath = this.options.devConfigPath;
    } catch {
      // The updater will report a real error if it cannot read its config.
    }
  }

  private async load(): Promise<UpdateAdapter | null> {
    if (this.updater) return this.updater;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const load =
          this.options.loadUpdater ??
          (async () => {
            const module = await import("electron-updater");
            return module.autoUpdater as unknown as UpdateAdapter;
          });
        const updater = await load();
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = true;
        updater.forceDevUpdateConfig = !this.options.packaged;
        this.updater = updater;
        this.bind(updater);
        this.applyFeed();
        return updater;
      } catch (error) {
        this.state = this.disabled(
          "module-missing",
          error instanceof Error ? error.message : String(error),
        );
        this.options.onState?.(this.state);
        return null;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private bind(updater: UpdateAdapter): void {
    updater.on("checking-for-update", () => {
      this.setStatus("checking", {
        checkedAt: this.now().toISOString(),
        message: null,
        availableVersion: null,
        percent: null,
      });
    });
    updater.on("update-available", (...args: unknown[]) => {
      const info = args[0] as { version?: unknown } | undefined;
      const version =
        typeof info?.version === "string" ? info.version : null;
      this.setStatus("available", {
        availableVersion: version,
        checkedAt: this.now().toISOString(),
        message: null,
      });
    });
    updater.on("update-not-available", () => {
      this.setStatus("not-available", {
        availableVersion: null,
        checkedAt: this.now().toISOString(),
        message: null,
      });
    });
    updater.on("download-progress", (...args: unknown[]) => {
      const progress = args[0] as
        | {
            percent?: unknown;
            bytesPerSecond?: unknown;
            transferred?: unknown;
            total?: unknown;
          }
        | undefined;
      const number = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const percent = number(progress?.percent);
      this.setStatus("downloading", {
        percent: percent === null ? 0 : Math.max(0, Math.min(100, percent)),
        bytesPerSecond: number(progress?.bytesPerSecond),
        transferred: number(progress?.transferred),
        total: number(progress?.total),
        message: null,
      });
    });
    updater.on("update-downloaded", (...args: unknown[]) => {
      const info = args[0] as { version?: unknown } | undefined;
      const version =
        typeof info?.version === "string" ? info.version : null;
      this.setStatus("downloaded", {
        availableVersion: version ?? this.state.availableVersion,
        percent: 100,
        message: null,
      });
    });
    updater.on("error", (...args: unknown[]) => {
      const error = args[0];
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Unknown update error";
      this.setStatus("error", { message });
    });
  }

  /** Load the updater without a network request. */
  async initialize(): Promise<UpdateState> {
    if (this.state.status === "disabled") return this.state;
    await this.load();
    return this.state;
  }

  async check(): Promise<UpdateState> {
    if (this.state.status === "disabled") return this.state;
    const updater = await this.load();
    if (!updater) return this.state;
    if (this.busy()) return this.state;
    this.setStatus("checking", {
      checkedAt: this.now().toISOString(),
      message: null,
    });
    try {
      const result = await updater.checkForUpdates();
      if (result === null) {
        this.state = this.disabled(
          "development",
          "The updater is inactive because this build is neither packaged nor configured with a feed.",
        );
        this.options.onState?.(this.state);
      }
    } catch (error) {
      this.setStatus("error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return this.state;
  }

  async download(): Promise<UpdateState> {
    if (this.state.status !== "available") return this.state;
    const updater = await this.load();
    if (!updater) return this.state;
    this.setStatus("downloading", { percent: 0, message: null });
    try {
      await updater.downloadUpdate();
    } catch (error) {
      this.setStatus("error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return this.state;
  }

  install(): boolean {
    if (this.state.status !== "downloaded" || !this.updater) return false;
    this.updater.quitAndInstall(false, true);
    return true;
  }
}

export { isReason };
