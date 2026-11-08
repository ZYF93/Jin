import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { UpdateState } from "../../../shared/ipc";
import {
  devUpdateConfig,
  normalizeFeedUrl,
  UpdateService,
  type UpdateAdapter,
  type UpdateServiceOptions,
} from "./update-service";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jin-update-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeUpdater implements UpdateAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  forceDevUpdateConfig = false;
  updateConfigPath: string | null = null;
  feed: { provider: "generic"; url: string } | null = null;
  checks = 0;
  downloads = 0;
  installArgs: [boolean?, boolean?] | null = null;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    return Promise.resolve({});
  }

  downloadUpdate(): Promise<unknown> {
    this.downloads += 1;
    return Promise.resolve({});
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installArgs = [isSilent, isForceRunAfter];
  }

  setFeedURL(options: { provider: "generic"; url: string }): void {
    this.feed = options;
  }
}

function create(
  overrides: Partial<UpdateServiceOptions> = {},
): {
  service: UpdateService;
  updater: FakeUpdater;
  states: UpdateState[];
} {
  const updater = new FakeUpdater();
  const states: UpdateState[] = [];
  const service = new UpdateService({
    currentVersion: "1.2.3",
    packaged: true,
    platform: "linux",
    feedUrl: "https://updates.example.com/jin/",
    loadUpdater: () => Promise.resolve(updater),
    onState: (state) => states.push(state),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    ...overrides,
  });
  return { service, updater, states };
}

describe("normalizeFeedUrl", () => {
  it("accepts http(s) feeds and strips trailing slashes", () => {
    expect(normalizeFeedUrl(" https://updates.example.com/jin/// ")).toBe(
      "https://updates.example.com/jin",
    );
    expect(normalizeFeedUrl("http://localhost:8080/feed")).toBe(
      "http://localhost:8080/feed",
    );
  });

  it("rejects empty and non-http feeds", () => {
    expect(normalizeFeedUrl("")).toBeNull();
    expect(normalizeFeedUrl(undefined)).toBeNull();
    expect(normalizeFeedUrl("ftp://example.com/feed")).toBeNull();
    expect(normalizeFeedUrl("not a url")).toBeNull();
  });
});

describe("devUpdateConfig", () => {
  it("writes a generic provider config electron-updater can read", () => {
    const yaml = devUpdateConfig("https://updates.example.com/jin");
    expect(yaml).toContain("provider: generic");
    expect(yaml).toContain('url: "https://updates.example.com/jin"');
    expect(yaml).toContain("updaterCacheDirName: jin-updater");
  });
});

describe("UpdateService", () => {
  it("disables updates on unsupported platforms", async () => {
    const { service, updater } = create({ platform: "freebsd" });
    expect(service.getState().status).toBe("disabled");
    expect(service.getState().reason).toBe("unsupported");
    expect(service.getState().canCheck).toBe(false);
    await service.check();
    expect(updater.checks).toBe(0);
  });

  it("disables updates in development without a feed", () => {
    const { service } = create({ packaged: false, feedUrl: "" });
    expect(service.getState().status).toBe("disabled");
    expect(service.getState().reason).toBe("development");
    expect(service.autoCheckEnabled).toBe(true);
  });

  it("loads the updater lazily, applies the feed and tracks the event flow", async () => {
    const { service, updater, states } = create();
    expect(updater.feed).toBeNull();

    await service.initialize();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.forceDevUpdateConfig).toBe(false);
    expect(updater.feed).toEqual({
      provider: "generic",
      url: "https://updates.example.com/jin",
    });

    await service.check();
    expect(updater.checks).toBe(1);
    expect(service.getState().status).toBe("checking");

    updater.emit("update-available", { version: "1.3.0" });
    expect(service.getState().status).toBe("available");
    expect(service.getState().availableVersion).toBe("1.3.0");
    expect(service.getState().canDownload).toBe(true);
    expect(service.getState().canInstall).toBe(false);

    await service.download();
    expect(updater.downloads).toBe(1);
    updater.emit("download-progress", {
      percent: 42.5,
      bytesPerSecond: 2048,
      transferred: 512,
      total: 1024,
    });
    expect(service.getState().status).toBe("downloading");
    expect(service.getState().percent).toBe(42.5);
    expect(service.getState().bytesPerSecond).toBe(2048);

    updater.emit("update-downloaded", { version: "1.3.0" });
    expect(service.getState().status).toBe("downloaded");
    expect(service.getState().canInstall).toBe(true);
    expect(service.install()).toBe(true);
    expect(updater.installArgs).toEqual([false, true]);

    expect(states.some((state) => state.status === "checking")).toBe(true);
    expect(states.some((state) => state.status === "downloaded")).toBe(true);
  });

  it("surfaces updater errors and update-not-available", async () => {
    const { service, updater } = create();
    await service.initialize();
    await service.check();

    updater.emit("update-not-available");
    expect(service.getState().status).toBe("not-available");
    expect(service.getState().availableVersion).toBeNull();

    updater.emit("error", new Error("feed unreachable"));
    expect(service.getState().status).toBe("error");
    expect(service.getState().message).toBe("feed unreachable");
    expect(service.getState().canCheck).toBe(true);
  });

  it("reconfigures auto-check and the feed without recreating the updater", async () => {
    const { service, updater } = create();
    await service.initialize();

    const state = service.configure({
      autoCheck: false,
      feedUrl: "https://mirror.example.com/jin",
    });
    expect(service.autoCheckEnabled).toBe(false);
    expect(state.status).toBe("idle");
    expect(updater.feed).toEqual({
      provider: "generic",
      url: "https://mirror.example.com/jin",
    });

    const cleared = service.configure({ autoCheck: true, feedUrl: "" });
    expect(service.autoCheckEnabled).toBe(true);
    expect(cleared.feedUrl).toBeNull();
  });

  it("writes the development update config when a feed is supplied", async () => {
    const root = tempRoot();
    const configPath = join(root, "dev-app-update.yml");
    const { service, updater } = create({
      packaged: false,
      feedUrl: "https://updates.example.com/jin",
      devConfigPath: configPath,
    });

    await service.initialize();
    expect(updater.forceDevUpdateConfig).toBe(true);
    expect(updater.updateConfigPath).toBe(configPath);
    expect(readFileSync(configPath, "utf8")).toContain(
      'url: "https://updates.example.com/jin"',
    );
  });
});
