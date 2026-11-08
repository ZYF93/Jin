import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScanManifest, ScanManifestEntry } from "./scanner";

const MANIFEST_FILE = "scan-manifest.json";

export function scanManifestPath(cacheDir: string): string {
  return join(cacheDir, MANIFEST_FILE);
}

function isEntry(value: unknown): value is ScanManifestEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.parserVersion === "number" &&
    typeof entry.mtimeMs === "number" &&
    typeof entry.size === "number" &&
    typeof entry.language === "string" &&
    typeof entry.lines === "number" &&
    Array.isArray(entry.imports) &&
    Array.isArray(entry.exports) &&
    Array.isArray(entry.members) &&
    typeof entry.kind === "string" &&
    typeof entry.title === "string" &&
    typeof entry.responsibility === "string"
  );
}

/** Read the previous scan manifest. A missing or corrupt cache is a cold scan, not an error. */
export function readScanManifest(cacheDir: string): ScanManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(scanManifestPath(cacheDir), "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const manifest: ScanManifest = {};
  for (const [path, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (isEntry(entry)) manifest[path] = entry;
  }
  return manifest;
}

/** Persist the manifest; a corrupt cache later just triggers a cold scan. */
export function writeScanManifest(cacheDir: string, manifest: ScanManifest): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(scanManifestPath(cacheDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
