import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { JinConfig } from "../project/config";
import { readScanManifest, scanManifestPath, writeScanManifest } from "./manifest";
import { scanProject } from "./scanner";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "jin-manifest-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/math.ts"), "export function sum(a: number, b: number) { return a + b; }\n", "utf8");
  writeFileSync(join(root, "src/other.ts"), "export function other() { return 1; }\n", "utf8");
  return root;
}

function config(): JinConfig {
  return {
    version: 1,
    project: { name: "Manifest", languages: ["typescript"] },
    scan: { roots: ["src"], ignore: [] },
    approval: { mode: "single", required: 1 },
    ui: { theme: "dark", glass: "subtle" },
  };
}

describe("scan manifest", () => {
  it("records mtime, size and parsed facts for every scanned file", () => {
    const root = fixture();
    const scan = scanProject(root, config());
    const entry = scan.manifest["src/math.ts"];
    expect(entry).toBeDefined();
    expect(entry?.mtimeMs).toBe(statSync(join(root, "src/math.ts")).mtimeMs);
    expect(entry?.exports).toEqual(["sum"]);
    expect(scan.manifest["src/other.ts"]?.exports).toEqual(["other"]);
  });

  it("reuses cached facts while mtime and size match", () => {
    const root = fixture();
    const file = join(root, "src/math.ts");
    const first = scanProject(root, config());

    // Same byte length, different exports; keep the cache key in sync with the new stats.
    writeFileSync(file, "export function mul(a: number, b: number) { return a * b; }\n", "utf8");
    const stats = statSync(file);
    const previous = first.manifest["src/math.ts"];
    const manifest = {
      ...first.manifest,
      "src/math.ts": { ...previous!, mtimeMs: stats.mtimeMs, size: stats.size },
    };

    const cached = scanProject(root, config(), { manifest });
    expect(cached.manifest["src/math.ts"]?.exports).toEqual(["sum"]);
    const node = cached.nodes.find((item) => item.file === "src/math.ts");
    expect(node?.metadata["exports"]).toEqual(["sum"]);

    const fresh = scanProject(root, config());
    expect(fresh.manifest["src/math.ts"]?.exports).toEqual(["mul"]);
  });

  it("reparses a file once its mtime changes", () => {
    const root = fixture();
    const file = join(root, "src/math.ts");
    const first = scanProject(root, config());
    writeFileSync(file, "export function mul(a: number, b: number) { return a * b; }\n", "utf8");
    utimesSync(file, new Date(), new Date(Date.now() + 2000));

    const rescanned = scanProject(root, config(), { manifest: first.manifest });
    expect(rescanned.manifest["src/math.ts"]?.exports).toEqual(["mul"]);
  });

  it("round-trips a manifest and treats corrupt cache as a cold scan", () => {
    const root = fixture();
    const cacheDir = join(root, ".jin", "cache");
    const scan = scanProject(root, config());
    writeScanManifest(cacheDir, scan.manifest);
    expect(readScanManifest(cacheDir)).toEqual(scan.manifest);

    writeFileSync(scanManifestPath(cacheDir), "{not json", "utf8");
    expect(readScanManifest(cacheDir)).toEqual({});
    expect(readScanManifest(join(root, "missing"))).toEqual({});
  });
});
