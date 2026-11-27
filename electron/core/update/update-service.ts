import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UpdateReason, UpdateState, UpdateStatus } from "../../../shared/ipc";

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
  /** Fetch a URL as text. Defaults to global fetch; injectable for tests. */
  fetchText?: (url: string) => Promise<string>;
}

const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["win32", "darwin", "linux"]);

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
    value === "module-missing" ||
    value === "feed-unreachable"
  );
}

/** The yml filename electron-updater's generic provider fetches per platform. */
function feedYmlFile(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "latest-mac.yml";
    case "linux":
      return "latest-linux.yml";
    default:
      return "latest.yml";
  }
}

/** Minimal YAML reader for the `version:` / `files:` lines electron-updater writes. */
function parseFeedYml(text: string): {
  version: string | null;
  downloadUrl: string | null;
  totalBytes: number | null;
} {
  let version: string | null = null;
  let downloadUrl: string | null = null;
  let totalBytes: number | null = null;
  let inFiles = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("version:")) {
      version =
        line
          .slice("version:".length)
          .trim()
          .replace(/^['"]|['"]$/g, "") || null;
      inFiles = false;
      continue;
    }
    if (line.startsWith("files:")) {
      inFiles = true;
      continue;
    }
    if (inFiles) {
      const url = line.match(/^\s*-?\s*url:\s*(\S+)/);
      if (url) downloadUrl = url[1].trim();
      const size = line.match(/^\s+size:\s*(\d+)/);
      if (size && totalBytes === null) totalBytes = Number(size[1]);
    }
  }
  return { version, downloadUrl, totalBytes };
}

/** Compare dotted versions; returns true when `candidate` is newer than `current`. */
export function isFeedVersionNewer(candidate: string, current: string): boolean {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, "")
      .split(".")
      .map((part) => parseInt(part, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
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
    this.feedUrl = normalizeFeedUrl(options.envFeedUrl) ?? normalizeFeedUrl(options.feedUrl);
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
      downloadUrl: null,
      manual: false,
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
      downloadUrl: null,
      manual: false,
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
    return this.state.status === "checking" || this.state.status === "downloading";
  }

  private setStatus(status: UpdateStatus, patch: Partial<UpdateState> = {}): UpdateState {
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
      writeFileSync(this.options.devConfigPath, devUpdateConfig(this.feedUrl), "utf8");
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
      const version = typeof info?.version === "string" ? info.version : null;
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
      const version = typeof info?.version === "string" ? info.version : null;
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
    if (this.state.status === "disabled") {
      // A feed is configured but the native updater is unavailable: fall back to
      // the direct feed so a dev/unsupported build can still see updates.
      if (this.feedUrl && this.state.reason !== "unsupported") {
        return this.checkViaFeed();
      }
      return this.state;
    }
    const updater = await this.load();
    if (!updater) return this.checkViaFeed();
    if (this.busy()) return this.state;
    this.setStatus("checking", {
      checkedAt: this.now().toISOString(),
      message: null,
    });
    try {
      const result = await updater.checkForUpdates();
      // `null` means the native updater is inactive (dev build) even though a
      // feed is set: fall back to fetching the feed directly.
      if (result === null) {
        return this.checkViaFeed();
      }
    } catch (error) {
      this.setStatus("error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return this.state;
  }

  /**
   * Fetch the feed's `latest*.yml` directly and surface any newer version.
   * Used when electron-updater cannot install in this build (dev, or a
   * missing module) but a reachable feed still exists: the user can open the
   * installer download manually.
   */
  async checkViaFeed(): Promise<UpdateState> {
    if (!this.feedUrl) {
      this.state = this.disabled("no-feed", "No update feed is configured.");
      this.options.onState?.(this.state);
      return this.state;
    }
    this.setStatus("checking", {
      checkedAt: this.now().toISOString(),
      message: null,
      manual: true,
      downloadUrl: null,
    });
    const url = `${this.feedUrl.replace(/\/+$/, "")}/${feedYmlFile(this.platform)}`;
    try {
      const fetchText =
        this.options.fetchText ??
        ((value: string) => fetch(value).then((response) => response.text()));
      const text = await fetchText(url);
      const { version, downloadUrl, totalBytes } = parseFeedYml(text);
      if (!version) {
        this.setStatus("not-available", {
          manual: true,
          downloadUrl: null,
          message: "The update feed did not report a version.",
        });
      } else if (!isFeedVersionNewer(version, this.options.currentVersion)) {
        this.setStatus("not-available", {
          availableVersion: version,
          manual: true,
          downloadUrl: null,
        });
      } else {
        this.setStatus("available", {
          availableVersion: version,
          manual: true,
          downloadUrl,
          total: totalBytes,
          percent: null,
          message: null,
        });
      }
      this.publish({
        canDownload: false,
        canInstall: Boolean(this.state.downloadUrl),
      });
    } catch (error) {
      this.state = this.disabled(
        "feed-unreachable",
        error instanceof Error ? error.message : String(error),
      );
      this.options.onState?.(this.state);
    }
    return this.state;
  }

  async download(): Promise<UpdateState> {
    if (this.state.status !== "available") return this.state;
    // The direct-feed fallback cannot stream a download; it exposes the
    // installer URL for the user to open, so "download" is a no-op here.
    if (this.state.manual) return this.state;
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

  /**
   * Native path: quit and install a downloaded update. For the manual feed
   * fallback, the installer is opened externally; returns true when the
   * updater action succeeded or the download URL was handed off.
   */
  install(openExternal?: (url: string) => void): boolean {
    if (this.state.status === "available" && this.state.downloadUrl) {
      if (openExternal) {
        openExternal(this.state.downloadUrl);
        return true;
      }
      this.publish({
        status: "downloaded",
        canInstall: true,
      });
      return true;
    }
    if (this.state.status !== "downloaded" || !this.updater) return false;
    this.updater.quitAndInstall(false, true);
    return true;
  }
}

export { isReason, parseFeedYml };
