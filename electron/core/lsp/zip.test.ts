import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { extractZip } from "./zip";

interface Entry {
  name: string;
  data: string;
  /** Unix mode including the file-type bits, for example 0o100755. */
  mode?: number;
}

/** Build a minimal stored (uncompressed) ZIP archive for extraction tests. */
function buildZip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const mode = entry.mode ?? 0o100644;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jin-zip-"));
  roots.push(root);
  return root;
}

describe("extractZip", () => {
  it("extracts nested files and preserves executable modes", () => {
    const root = tempRoot();
    const destination = join(root, "extension");
    const entries = extractZip(
      buildZip([
        { name: "extension/package.json", data: '{"name":"demo"}' },
        { name: "extension/server/rust-analyzer", data: "#!/bin/sh\n", mode: 0o100755 },
      ]),
      destination,
    );

    expect(entries.map((entry) => entry.name)).toEqual([
      "extension/package.json",
      "extension/server/rust-analyzer",
    ]);
    expect(
      readFileSync(join(destination, "extension", "package.json"), "utf8"),
    ).toBe('{"name":"demo"}');
    expect(
      statSync(join(destination, "extension", "server", "rust-analyzer")).mode & 0o777,
    ).toBe(0o755);
  });

  it("skips traversal paths and symlink entries", () => {
    const root = tempRoot();
    const destination = join(root, "extension");
    extractZip(
      buildZip([
        { name: "../escaped.txt", data: "nope" },
        { name: "extension/link", data: "../../etc/passwd", mode: 0o120777 },
        { name: "extension/safe.txt", data: "safe" },
      ]),
      destination,
    );

    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
    expect(existsSync(join(destination, "escaped.txt"))).toBe(false);
    expect(existsSync(join(destination, "extension", "link"))).toBe(false);
    expect(readFileSync(join(destination, "extension", "safe.txt"), "utf8")).toBe(
      "safe",
    );
  });

  it("rejects archives that exceed per-file or total size limits", () => {
    const root = tempRoot();
    const archive = buildZip([
      { name: "extension/big.bin", data: "0123456789" },
    ]);

    expect(() =>
      extractZip(archive, join(root, "file-limit"), { maxFileBytes: 4 }),
    ).toThrow(/too large/);
    expect(() =>
      extractZip(archive, join(root, "total-limit"), { maxTotalBytes: 4 }),
    ).toThrow(/size limit/);
    expect(() =>
      extractZip(archive, join(root, "entry-limit"), { maxEntries: 0 }),
    ).toThrow(/too many files/);
  });

  it("rejects data that is not a ZIP archive", () => {
    const root = tempRoot();
    expect(() =>
      extractZip(Buffer.from("not a zip"), join(root, "bad")),
    ).toThrow(/end-of-central-directory/);
  });
});
