import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export interface ZipLimits {
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface ZipEntry {
  name: string;
  mode: number;
  size: number;
}

function u16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function u32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function safeName(raw: string): string | null {
  const name = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!name || name.includes("\0")) return null;
  const parts = name.split("/");
  if (parts.some((part) => part === ".." || part === ".")) return null;
  return name;
}

/**
 * Extract a VSIX (a plain ZIP) without external tools.
 *
 * Symlink entries are rejected, paths are confined to `destination`, and both
 * per-file and total sizes are capped. Jin only extracts user-selected VS Code
 * extensions, but a marketplace download is still untrusted input.
 */
export function extractZip(
  buffer: Buffer,
  destination: string,
  limits: ZipLimits = {},
): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 20_000;
  const maxFileBytes = limits.maxFileBytes ?? 64 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 512 * 1024 * 1024;
  const root = resolve(destination);
  const searchStart = Math.max(0, buffer.length - 66_000);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (u32(buffer, offset) === EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid VSIX: ZIP end-of-central-directory not found");
  const entries = u16(buffer, eocd + 10);
  const centralSize = u32(buffer, eocd + 12);
  const centralOffset = u32(buffer, eocd + 16);
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 VSIX files are not supported");
  }
  if (entries > maxEntries) throw new Error("VSIX contains too many files");
  if (centralOffset + centralSize > buffer.length) {
    throw new Error("Invalid VSIX: central directory is truncated");
  }

  const written: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (u32(buffer, cursor) !== CENTRAL) {
      throw new Error("Invalid VSIX: central directory entry is malformed");
    }
    const madeBy = u16(buffer, cursor + 4);
    const method = u16(buffer, cursor + 10);
    const compressedSize = u32(buffer, cursor + 20);
    const uncompressedSize = u32(buffer, cursor + 24);
    const nameLength = u16(buffer, cursor + 28);
    const extraLength = u16(buffer, cursor + 30);
    const commentLength = u16(buffer, cursor + 32);
    const externalAttributes = u32(buffer, cursor + 38);
    const localOffset = u32(buffer, cursor + 42);
    const rawName = buffer
      .slice(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    const name = safeName(rawName);
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    const unixMode = madeBy >> 8 === 3 ? externalAttributes >>> 16 : 0;
    const kind = unixMode & 0o170000;
    if (kind === 0o120000) continue; // Never materialize symlinks.
    const directory = name.endsWith("/") || kind === 0o040000;
    if (directory) continue;
    if (uncompressedSize > maxFileBytes) {
      throw new Error(`VSIX entry is too large: ${name}`);
    }
    total += uncompressedSize;
    if (total > maxTotalBytes) throw new Error("VSIX expands beyond the size limit");

    if (u32(buffer, localOffset) !== LOCAL) {
      throw new Error(`Invalid VSIX: local header missing for ${name}`);
    }
    const localNameLength = u16(buffer, localOffset + 26);
    const localExtraLength = u16(buffer, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new Error(`Invalid VSIX: data truncated for ${name}`);
    }
    const compressed = buffer.slice(dataStart, dataEnd);
    let data: Buffer;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = inflateRawSync(compressed, { maxOutputLength: maxFileBytes });
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    if (uncompressedSize > 0 && data.length !== uncompressedSize) {
      throw new Error(`Invalid VSIX: size mismatch for ${name}`);
    }

    const absolute = resolve(root, name);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw new Error(`VSIX entry escapes the install directory: ${name}`);
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, data, { mode: unixMode || 0o644 });
    if (unixMode) {
      try {
        chmodSync(absolute, (unixMode & 0o777) || 0o644);
      } catch {
        // Windows and some filesystems ignore chmod.
      }
    }
    written.push({ name, mode: unixMode & 0o777, size: data.length });
  }
  return written;
}
