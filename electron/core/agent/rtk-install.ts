import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RtkStatus } from "../../../shared/ipc";
import { rtkInstallDir, rtkStatus } from "./rtk";

const RELEASE_LATEST = "https://github.com/rtk-ai/rtk/releases/latest";
const RELEASES_API = "https://api.github.com/repos/rtk-ai/rtk/releases/latest";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const LOOKUP_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const USER_AGENT = "Jin/0.1";

export interface RtkRelease {
  tag: string;
  asset: string;
  base: string;
}

/**
 * The release target triple for a platform, mirroring the install script.
 * Returns null where Jin cannot auto-install (Windows: use winget or the
 * GitHub release zip manually).
 */
export function rtkTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
    return null;
  }
  return null;
}

export function releaseForTag(tag: string, target: string): RtkRelease {
  return {
    tag,
    asset: `rtk-${target}.tar.gz`,
    base: `https://github.com/rtk-ai/rtk/releases/download/${encodeURIComponent(tag)}`,
  };
}

export function checksumFor(text: string, asset: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2].trim() === asset) return match[1].toLowerCase();
  }
  return null;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fetchBuffer(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`RTK download failed: ${response.status} ${response.statusText}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new Error("RTK download is larger than the safe limit");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error("RTK download is larger than the safe limit");
  return buffer;
}

/** Latest release tag, via the 302 redirect first to avoid API rate limits. */
export async function latestRtkTag(): Promise<string> {
  try {
    const head = await fetch(RELEASE_LATEST, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    const location = head.headers.get("location") ?? "";
    const tag = /\/tag\/([^/?#]+)$/.exec(location)?.[1];
    if (tag) return decodeURIComponent(tag);
  } catch {
    // Fall through to the REST API.
  }
  const response = await fetch(RELEASES_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Could not look up the latest RTK release (${response.status})`);
  }
  const body = (await response.json()) as { tag_name?: string };
  if (!body.tag_name) throw new Error("The RTK release lookup returned no version");
  return body.tag_name;
}

function unpack(archivePath: string, dir: string): void {
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", dir], {
    encoding: "utf8",
    timeout: EXTRACT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw new Error(`tar is required to unpack RTK: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not unpack the RTK archive");
  }
}

function findBinary(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === "rtk") return path;
    if (entry.isDirectory()) {
      const nested = findBinary(path);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Download and install the latest RTK release into Jin's user-data bin
 * directory, verifying the SHA-256 published on the release. Throws when
 * the platform is unsupported or anything fails; callers translate the
 * message for the UI.
 */
export async function installRtk(): Promise<RtkStatus> {
  const installDir = rtkInstallDir();
  if (!installDir) throw new Error("Jin has not configured an RTK install directory yet");
  const target = rtkTarget();
  if (!target) {
    throw new Error(
      "Automatic RTK install is only available on Linux and macOS. On Windows, install it with winget (winget install rtk-ai.rtk) or from the RTK releases page.",
    );
  }
  const tag = await latestRtkTag();
  const { asset, base } = releaseForTag(tag, target);
  const [checksums, archive] = await Promise.all([
    fetchBuffer(`${base}/checksums.txt`, DOWNLOAD_TIMEOUT_MS, 1_048_576),
    fetchBuffer(`${base}/${asset}`, DOWNLOAD_TIMEOUT_MS, MAX_ARCHIVE_BYTES),
  ]);
  const expected = checksumFor(checksums.toString("utf8"), asset);
  if (!expected) throw new Error(`No published checksum for ${asset}`);
  if (sha256Hex(archive) !== expected) {
    throw new Error("RTK download failed the checksum check; nothing was installed");
  }
  const work = mkdtempSync(join(tmpdir(), "jin-rtk-"));
  try {
    const archivePath = join(work, asset);
    writeFileSync(archivePath, archive);
    unpack(archivePath, work);
    const source = findBinary(work);
    if (!source) throw new Error("The RTK archive did not contain an rtk binary");
    mkdirSync(installDir, { recursive: true });
    const destination = join(installDir, process.platform === "win32" ? "rtk.exe" : "rtk");
    try {
      renameSync(source, destination);
    } catch {
      copyFileSync(source, destination);
    }
    chmodSync(destination, 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const status = rtkStatus();
  if (!status.installed) throw new Error("RTK was downloaded but did not run");
  return status;
}
