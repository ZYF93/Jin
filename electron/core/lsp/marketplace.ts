import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  MarketplaceExtension,
  MarketplaceSearchResult,
} from "../../../shared/ipc";
import type { LanguageServerSpec } from "./registry";
import { extractZip } from "./zip";

const GALLERY_URL =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const GALLERY_HEADERS = {
  accept: "application/json;api-version=7.2-preview.1",
  "content-type": "application/json",
  "user-agent": "Jin/0.1 (+https://github.com/jin-arch)",
};
const REGISTRY_FILE = "installed.json";
const MAX_VSIX_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180_000;

interface GalleryFile {
  assetType?: string;
  source?: string;
}

interface GalleryVersion {
  version?: string;
  targetPlatform?: string;
  lastUpdated?: string;
  files?: GalleryFile[];
}

interface GalleryExtension {
  publisher?: {
    publisherName?: string;
    displayName?: string;
    flags?: string;
    isDomainVerified?: boolean;
  };
  extensionName?: string;
  displayName?: string;
  shortDescription?: string;
  lastUpdated?: string;
  flags?: string;
  versions?: GalleryVersion[];
  statistics?: Array<{ statisticName?: string; value?: number }>;
}

interface GalleryResponse {
  results?: Array<{
    extensions?: GalleryExtension[];
    resultMetadata?: Array<{
      metadataType?: string;
      metadataItems?: Array<{ name?: string; count?: number }>;
    }>;
  }>;
}

export interface InstalledLspRecord {
  id: string;
  publisher: string;
  name: string;
  displayName: string;
  version: string;
  installedAt: string;
  directory: string;
  kind: "binary" | "node";
  /** Path relative to `directory`. */
  entry: string;
  args: string[];
  language: string;
  extensions: string[];
  iconUrl?: string;
}

export interface InstallOutcome {
  record: InstalledLspRecord;
  extension: MarketplaceExtension;
}

interface KnownEntry {
  path: string;
  kind: "binary" | "node";
  args?: string[];
  language?: string;
  extensions?: string[];
}

/**
 * Some Marketplace extensions ship a language server that is licensed only for
 * a specific IDE. Jin must not bypass that gate.
 */
const LICENSE_GATED: Record<string, string> = {
  "ms-python.vscode-pylance":
    "Pylance is licensed for Visual Studio products only and refuses to run as a standalone server. Install ms-pyright.pyright instead.",
};

const KNOWN_ENTRIES: Record<string, KnownEntry[]> = {
  "ms-pyright.pyright": [
    {
      path: "dist/server.js",
      kind: "node",
      args: ["--stdio"],
      language: "Python",
      extensions: [".py", ".pyi"],
    },
  ],
  "rust-lang.rust-analyzer": [
    { path: "server/rust-analyzer", kind: "binary", language: "Rust", extensions: [".rs"] },
    {
      path: "server/rust-analyzer.exe",
      kind: "binary",
      language: "Rust",
      extensions: [".rs"],
    },
  ],
  "redhat.java": [
    { path: "server/bin/jdtls", kind: "binary", language: "Java", extensions: [".java"] },
    {
      path: "server/bin/jdtls.bat",
      kind: "binary",
      language: "Java",
      extensions: [".java"],
    },
  ],
  "vue.volar": [
    {
      path: "node_modules/@vue/language-server/bin/vue-language-server.js",
      kind: "node",
      args: ["--stdio"],
      language: "Vue",
      extensions: [".vue"],
    },
  ],
  "svelte.svelte-vscode": [
    {
      path: "node_modules/svelte-language-server/bin/server.js",
      kind: "node",
      args: ["--stdio"],
      language: "Svelte",
      extensions: [".svelte"],
    },
  ],
  "astro-build.astro-vscode": [
    {
      path: "node_modules/@astrojs/language-server/bin/nodeServer.js",
      kind: "node",
      args: ["--stdio"],
      language: "Astro",
      extensions: [".astro"],
    },
  ],
  "bradlc.vscode-tailwindcss": [
    {
      path: "dist/server.js",
      kind: "node",
      args: ["--stdio"],
      language: "Tailwind CSS",
      extensions: [".html", ".css", ".tsx", ".jsx", ".vue", ".svelte"],
    },
  ],
};

const LANGUAGE_NAMES: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript React",
  ".js": "JavaScript",
  ".jsx": "JavaScript React",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".astro": "Astro",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".rb": "Ruby",
  ".php": "PHP",
  ".c": "C",
  ".h": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cxx": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".lua": "Lua",
  ".dart": "Dart",
  ".swift": "Swift",
  ".zig": "Zig",
  ".toml": "TOML",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".json": "JSON",
  ".sh": "Shell",
  ".bash": "Shell",
  ".tf": "Terraform",
  ".sql": "SQL",
  ".scala": "Scala",
  ".hs": "Haskell",
  ".ex": "Elixir",
  ".exs": "Elixir",
};

const SERVER_BASENAMES_BY_EXTENSION: Record<string, string[]> = {
  ".rs": ["rust-analyzer"],
  ".go": ["gopls"],
  ".py": ["pyright-langserver", "pylsp", "jedi-language-server"],
  ".ts": ["typescript-language-server", "vtsls"],
  ".tsx": ["typescript-language-server", "vtsls"],
  ".js": ["typescript-language-server", "vtsls"],
  ".jsx": ["typescript-language-server", "vtsls"],
  ".vue": ["vue-language-server"],
  ".svelte": ["svelteserver", "server"],
  ".astro": ["nodeServer", "astro-ls"],
  ".java": ["jdtls", "java-language-server"],
  ".kt": ["kotlin-language-server"],
  ".kts": ["kotlin-language-server"],
  ".rb": ["ruby-lsp", "solargraph"],
  ".php": ["intelephense", "phpactor"],
  ".c": ["clangd"],
  ".h": ["clangd"],
  ".cc": ["clangd"],
  ".cpp": ["clangd"],
  ".cxx": ["clangd"],
  ".hpp": ["clangd"],
  ".cs": ["omnisharp", "csharp-ls"],
  ".lua": ["lua-language-server"],
  ".dart": ["dart"],
  ".swift": ["sourcekit-lsp"],
  ".zig": ["zls"],
  ".toml": ["taplo"],
  ".yaml": ["yaml-language-server"],
  ".yml": ["yaml-language-server"],
  ".json": ["vscode-json-language-server"],
  ".sh": ["bash-language-server"],
  ".bash": ["bash-language-server"],
  ".tf": ["terraform-ls"],
  ".sql": ["sql-language-server"],
  ".scala": ["metals"],
  ".hs": ["haskell-language-server-wrapper"],
  ".ex": ["language_server.sh", "elixir-ls"],
  ".exs": ["language_server.sh", "elixir-ls"],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function platformKey(
  platform = process.platform,
  arch = process.arch,
): string {
  return `${platform}-${arch}`;
}

export function pickVersion(
  versions: readonly GalleryVersion[] = [],
  platform = platformKey(),
): GalleryVersion | null {
  if (versions.length === 0) return null;
  const exact = versions.find((version) => version.targetPlatform === platform);
  if (exact) return exact;
  const universal = versions.find((version) => !version.targetPlatform);
  return universal ?? versions[0] ?? null;
}

function statValue(extension: GalleryExtension, name: string): number {
  const found = extension.statistics?.find(
    (statistic) => statistic.statisticName === name,
  );
  return typeof found?.value === "number" && Number.isFinite(found.value)
    ? found.value
    : 0;
}

function extensionIdOf(extension: GalleryExtension): string {
  const publisher = stringValue(extension.publisher?.publisherName);
  const name = stringValue(extension.extensionName);
  return publisher && name ? `${publisher}.${name}` : "";
}

export function marketplaceExtension(
  raw: GalleryExtension,
  installed: InstalledLspRecord | undefined,
  platform = platformKey(),
): MarketplaceExtension | null {
  const publisher = stringValue(raw.publisher?.publisherName);
  const name = stringValue(raw.extensionName);
  if (!publisher || !name) return null;
  const version = pickVersion(raw.versions, platform);
  if (!version?.version) return null;
  const files = version.files ?? [];
  const iconUrl =
    files.find(
      (file) => file.assetType === "Microsoft.VisualStudio.Services.Icons.Default",
    )?.source ??
    files.find(
      (file) => file.assetType === "Microsoft.VisualStudio.Services.Icons.Small",
    )?.source;
  return {
    id: `${publisher}.${name}`,
    publisher,
    name,
    displayName: stringValue(raw.displayName) || name,
    description: stringValue(raw.shortDescription),
    version: version.version,
    installs: statValue(raw, "install"),
    rating: statValue(raw, "averagerating"),
    lastUpdated: stringValue(version.lastUpdated) || stringValue(raw.lastUpdated),
    ...(iconUrl ? { iconUrl } : {}),
    verified:
      stringValue(raw.publisher?.flags).includes("verified") ||
      raw.publisher?.isDomainVerified === true,
    installed: Boolean(installed),
    ...(installed
      ? {
          installedVersion: installed.version,
          server: installed.entry,
        }
      : {}),
  };
}

function parseSearchResponse(
  value: unknown,
  installed: readonly InstalledLspRecord[],
  platform = platformKey(),
): MarketplaceSearchResult {
  const response = asRecord(value) as GalleryResponse | null;
  const result = response?.results?.[0];
  const count =
    result?.resultMetadata
      ?.find((metadata) => metadata.metadataType === "ResultCount")
      ?.metadataItems?.find((item) => item.name === "TotalCount")?.count ?? 0;
  const byId = new Map(installed.map((record) => [record.id, record]));
  const extensions = (result?.extensions ?? [])
    .map((extension) =>
      marketplaceExtension(
        extension,
        byId.get(extensionIdOf(extension)),
        platform,
      ),
    )
    .filter((extension): extension is MarketplaceExtension => extension !== null);
  return { total: count || extensions.length, extensions };
}

function safeDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return (
      url.hostname === "marketplace.visualstudio.com" ||
      url.hostname.endsWith(".gallerycdn.vsassets.io") ||
      url.hostname.endsWith(".gallerycdn.azure.cn") ||
      url.hostname.endsWith(".vsassets.io")
    );
  } catch {
    return false;
  }
}

async function readLimited(
  response: Response,
  limit: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    throw new Error("The VSIX download is larger than Jin's safety limit.");
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) {
      throw new Error("The VSIX download is larger than Jin's safety limit.");
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("The VSIX download is larger than Jin's safety limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function languageInfo(packageJson: Record<string, unknown>): {
  language: string;
  extensions: string[];
} {
  const contributes = asRecord(packageJson.contributes);
  const languages = Array.isArray(contributes?.languages)
    ? contributes.languages
    : [];
  const extensions = new Set<string>();
  let language = "";
  for (const item of languages) {
    const entry = asRecord(item);
    if (!entry) continue;
    const aliases = Array.isArray(entry.aliases)
      ? entry.aliases.filter((alias): alias is string => typeof alias === "string")
      : [];
    if (!language) language = aliases[0] ?? stringValue(entry.id);
    if (Array.isArray(entry.extensions)) {
      for (const extension of entry.extensions) {
        if (typeof extension !== "string") continue;
        const normalized = extension.startsWith(".")
          ? extension.toLowerCase()
          : `.${extension.toLowerCase()}`;
        if (normalized.length > 1) extensions.add(normalized);
      }
    }
  }
  return { language, extensions: [...extensions] };
}

function walk(
  root: string,
  visitor: (absolute: string, relativePath: string, size: number) => void,
  maxDepth = 9,
): void {
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "__pycache__") continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        visitor(absolute, relative(root, absolute).split(sep).join("/"), statSync(absolute).size);
      } catch {
        // Ignore files that disappear during the walk.
      }
    }
  };
  visit(root, 0);
}

export interface DetectedServer {
  entry: string;
  kind: "binary" | "node";
  args: string[];
  language: string;
  extensions: string[];
}

/**
 * Find a standalone language-server entry inside an extracted extension.
 *
 * Only recognized LSP executables/scripts are launched: the extension's
 * `main` activation bundle is never executed.
 */
export function detectStandaloneServer(
  extensionRoot: string,
  packageJson: Record<string, unknown>,
  extensionId: string,
): DetectedServer | null {
  const info = languageInfo(packageJson);
  const known = KNOWN_ENTRIES[extensionId] ?? [];
  for (const candidate of known) {
    const absolute = resolve(extensionRoot, candidate.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    return {
      entry: candidate.path,
      kind: candidate.kind,
      args: candidate.args ?? [],
      language:
        candidate.language ??
        (info.language ||
          LANGUAGE_NAMES[candidate.extensions?.[0] ?? ""] ||
          extensionId),
      extensions:
        candidate.extensions ??
        (info.extensions.length > 0 ? info.extensions : [".py"]),
    };
  }

  const wanted = new Set<string>();
  const extensions =
    info.extensions.length > 0 ? info.extensions : Object.keys(LANGUAGE_NAMES);
  for (const extension of extensions) {
    for (const name of SERVER_BASENAMES_BY_EXTENSION[extension] ?? []) {
      wanted.add(name.toLowerCase());
    }
  }
  const aliases = new Set<string>();
  for (const name of wanted) {
    aliases.add(name);
    aliases.add(`${name}.exe`);
    aliases.add(`${name}.js`);
    aliases.add(`${name}.cjs`);
    aliases.add(`${name}.cmd`);
    aliases.add(`${name}.bat`);
  }

  // package.json bin entries are documented CLIs. Keep the whitelist strict so
  // an extension's ordinary activation code is never mistaken for a server.
  const bin = asRecord(packageJson.bin);
  const binEntries = new Set<string>();
  if (bin) {
    for (const value of Object.values(bin)) {
      if (typeof value !== "string") continue;
      const file = value.replace(/^\.\//, "");
      if (aliases.has(basename(file).toLowerCase())) binEntries.add(file);
    }
  }

  let best: { path: string; score: number } | null = null;
  walk(extensionRoot, (absolute, relativePath) => {
    const lower = basename(absolute).toLowerCase();
    if (!aliases.has(lower)) return;
    const depth = relativePath.split("/").length;
    const inServer = /(^|\/)(server|bin)(\/|$)/i.test(relativePath) ? 8 : 0;
    const score = inServer + Math.max(0, 12 - depth);
    if (!best || score > best.score) best = { path: relativePath, score };
  });
  for (const path of binEntries) {
    if (!best) best = { path, score: 20 };
  }
  if (!best) return null;
  const selected: { path: string; score: number } = best;
  const lower = basename(selected.path).toLowerCase();
  const kind: "binary" | "node" =
    lower.endsWith(".js") || lower.endsWith(".cjs") || lower.endsWith(".mjs")
      ? "node"
      : "binary";
  const extension =
    extensions.find((candidate) => SERVER_BASENAMES_BY_EXTENSION[candidate]?.some(
      (name) => aliases.has(name.toLowerCase()) && selected.path.toLowerCase().includes(name.toLowerCase()),
    )) ??
    extensions[0] ??
    ".ts";
  return {
    entry: selected.path,
    kind,
    args: kind === "node" ? ["--stdio"] : [],
    language: info.language || LANGUAGE_NAMES[extension] || extensionId,
    extensions: info.extensions.length > 0 ? info.extensions : [extension],
  };
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export class LspMarketplace {
  constructor(private readonly root: string) {}

  private registryPath(): string {
    return join(this.root, REGISTRY_FILE);
  }

  private records(): InstalledLspRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.registryPath(), "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => {
          const record = asRecord(item);
          if (!record) return null;
          const id = stringValue(record.id);
          const version = stringValue(record.version);
          const directory = stringValue(record.directory);
          const entry = stringValue(record.entry);
          if (!id || !version || !directory || !entry) return null;
          return {
            id,
            publisher: stringValue(record.publisher),
            name: stringValue(record.name),
            displayName: stringValue(record.displayName) || id,
            version,
            installedAt: stringValue(record.installedAt),
            directory,
            kind: record.kind === "node" ? "node" : "binary",
            entry,
            args: Array.isArray(record.args)
              ? record.args.filter((arg): arg is string => typeof arg === "string")
              : [],
            language: stringValue(record.language) || "Language",
            extensions: Array.isArray(record.extensions)
              ? record.extensions.filter(
                  (extension): extension is string => typeof extension === "string",
                )
              : [],
            ...(typeof record.iconUrl === "string" ? { iconUrl: record.iconUrl } : {}),
          } satisfies InstalledLspRecord;
        })
        .filter((record): record is InstalledLspRecord => record !== null);
    } catch {
      return [];
    }
  }

  private writeRecords(records: readonly InstalledLspRecord[]): void {
    mkdirSync(this.root, { recursive: true });
    const temp = `${this.registryPath()}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(records, null, 2), "utf8");
    renameSync(temp, this.registryPath());
  }

  installed(): InstalledLspRecord[] {
    return this.records();
  }

  specs(): LanguageServerSpec[] {
    return this.records().map((record) => {
      const absolute = join(record.directory, record.entry);
      if (record.kind === "node") {
        return {
          id: `marketplace:${record.id}`,
          language: record.language,
          extensions: record.extensions,
          commands: [process.execPath],
          installHint: "Reinstall this extension from the VS Code Marketplace.",
          source: "marketplace" as const,
          extensionId: record.id,
          version: record.version,
          installedAt: record.installedAt,
          displayName: record.displayName,
          // Pylance (and some other VS Code servers) refuse to start unless
          // both Electron/Node env markers and a client process id are present.
          // This is the same launch contract the VS Code extension uses.
          args: [
            absolute,
            ...record.args,
            `--clientProcessId=${process.pid}`,
          ],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            VSCODE_NLS_CONFIG: JSON.stringify({
              locale: "en",
              availableLanguages: {},
            }),
          },
          entryPath: absolute,
          commandLabel: absolute,
        };
      }
      return {
        id: `marketplace:${record.id}`,
        language: record.language,
        extensions: record.extensions,
        commands: [absolute],
        installHint: "Reinstall this extension from the VS Code Marketplace.",
        source: "marketplace" as const,
        extensionId: record.id,
        version: record.version,
        installedAt: record.installedAt,
        displayName: record.displayName,
        args: record.args,
        entryPath: absolute,
        commandLabel: absolute,
      };
    });
  }

  async search(query: string, limit = 12): Promise<MarketplaceSearchResult> {
    const text = query.trim() || "language server";
    const response = await fetch(GALLERY_URL, {
      method: "POST",
      headers: GALLERY_HEADERS,
      body: JSON.stringify({
        filters: [
          {
            criteria: [
              { filterType: 10, value: text },
              { filterType: 8, value: "Microsoft.VisualStudio.Code" },
            ],
            pageNumber: 1,
            pageSize: Math.max(1, Math.min(30, Math.trunc(limit))),
            sortBy: 0,
            sortOrder: 0,
          },
        ],
        assetTypes: [],
        flags: 914,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`VS Code Marketplace returned ${response.status} ${response.statusText}`);
    }
    return parseSearchResponse(await response.json(), this.records());
  }

  private async queryExact(id: string): Promise<GalleryExtension | null> {
    const response = await fetch(GALLERY_URL, {
      method: "POST",
      headers: GALLERY_HEADERS,
      body: JSON.stringify({
        filters: [
          {
            criteria: [
              { filterType: 7, value: id },
              { filterType: 8, value: "Microsoft.VisualStudio.Code" },
            ],
            pageNumber: 1,
            pageSize: 10,
            sortBy: 0,
            sortOrder: 0,
          },
        ],
        assetTypes: [],
        flags: 914,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`VS Code Marketplace returned ${response.status} ${response.statusText}`);
    }
    const parsed = (await response.json()) as GalleryResponse;
    return (
      parsed.results?.[0]?.extensions?.find(
        (extension) => extensionIdOf(extension).toLowerCase() === id.toLowerCase(),
      ) ?? null
    );
  }

  async install(id: string): Promise<InstallOutcome> {
    if (!/^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*$/i.test(id)) {
      throw new Error("Extension id must look like publisher.extension.");
    }
    const gated = LICENSE_GATED[id.toLowerCase()];
    if (gated) throw new LicenseGatedServerError(gated);
    const extension = await this.queryExact(id);
    if (!extension) throw new Error(`Extension ${id} was not found in the VS Code Marketplace.`);
    const version = pickVersion(extension.versions);
    if (!version?.version) throw new Error(`Extension ${id} has no downloadable version.`);
    const vsixFile = version.files?.find(
      (file) => file.assetType === "Microsoft.VisualStudio.Services.VSIXPackage",
    );
    const downloadUrl =
      vsixFile?.source ??
      `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${encodeURIComponent(
        stringValue(extension.publisher?.publisherName),
      )}/vsextensions/${encodeURIComponent(stringValue(extension.extensionName))}/${encodeURIComponent(
        version.version,
      )}/vspackage`;
    if (!safeDownloadUrl(downloadUrl)) {
      throw new Error("The Marketplace returned an unsafe VSIX download URL.");
    }

    const tempRoot = join(
      this.root,
      ".tmp",
      `${safeId(id)}-${version.version}-${Date.now()}`,
    );
    const extracted = join(tempRoot, "extracted");
    mkdirSync(extracted, { recursive: true });
    try {
      const response = await fetch(downloadUrl, {
        headers: { "user-agent": GALLERY_HEADERS["user-agent"] },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`VSIX download failed with ${response.status} ${response.statusText}`);
      }
      const buffer = await readLimited(response, MAX_VSIX_BYTES);
      const vsixPath = join(tempRoot, "extension.vsix");
      writeFileSync(vsixPath, buffer);
      extractZip(buffer, extracted);

      const extensionRoot = join(extracted, "extension");
      const packagePath = join(extensionRoot, "package.json");
      if (!existsSync(packagePath)) {
        throw new Error("The VSIX does not contain extension/package.json.");
      }
      const packageJson = asRecord(JSON.parse(readFileSync(packagePath, "utf8")));
      if (!packageJson) throw new Error("The extension package.json is not an object.");
      const server = detectStandaloneServer(extensionRoot, packageJson, id);
      if (!server) {
        throw new NoStandaloneServerError(
          "This extension does not expose a recognized standalone language-server entry. Jin does not run VS Code activation code.",
        );
      }

      const old = this.records();
      const previous = old.find((record) => record.id.toLowerCase() === id.toLowerCase());
      if (previous) {
        try {
          rmSync(previous.directory, { recursive: true, force: true });
        } catch {
          // A stale directory is harmless; the new record points elsewhere.
        }
      }
      const directory = join(this.root, `${safeId(id)}-${safeId(version.version)}`);
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(dirname(directory), { recursive: true });
      renameSync(extensionRoot, directory);
      const entryAbsolute = join(directory, server.entry);
      if (!existsSync(entryAbsolute)) {
        throw new Error("The language-server entry disappeared during installation.");
      }
      if (server.kind === "binary" && process.platform !== "win32") {
        try {
          chmodSync(entryAbsolute, 0o755);
        } catch {
          // Some filesystems mount read-only; spawning will report a clear error.
        }
      }
      const files = version.files ?? [];
      const iconUrl =
        files.find(
          (file) => file.assetType === "Microsoft.VisualStudio.Services.Icons.Default",
        )?.source ??
        files.find(
          (file) => file.assetType === "Microsoft.VisualStudio.Services.Icons.Small",
        )?.source;
      const record: InstalledLspRecord = {
        id,
        publisher: stringValue(extension.publisher?.publisherName),
        name: stringValue(extension.extensionName),
        displayName: stringValue(extension.displayName) || id,
        version: version.version,
        installedAt: new Date().toISOString(),
        directory,
        kind: server.kind,
        entry: server.entry,
        args: server.args,
        language: server.language,
        extensions: server.extensions,
        ...(iconUrl ? { iconUrl } : {}),
      };
      const next = [
        ...old.filter((candidate) => candidate.id.toLowerCase() !== id.toLowerCase()),
        record,
      ];
      this.writeRecords(next);
      const marketplace = marketplaceExtension(extension, record);
      if (!marketplace) throw new Error("The installed extension metadata is incomplete.");
      return { record, extension: marketplace };
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  uninstall(id: string): InstalledLspRecord | null {
    const records = this.records();
    const record = records.find(
      (candidate) => candidate.id.toLowerCase() === id.toLowerCase(),
    );
    if (!record) return null;
    rmSync(record.directory, { recursive: true, force: true });
    this.writeRecords(
      records.filter((candidate) => candidate.id.toLowerCase() !== id.toLowerCase()),
    );
    return record;
  }
}

export class NoStandaloneServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoStandaloneServerError";
  }
}

export class LicenseGatedServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LicenseGatedServerError";
  }
}

export { parseSearchResponse };
