import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { LspStatus } from "../../../shared/ipc";

export interface LanguageServerSpec {
  id: string;
  language: string;
  extensions: string[];
  commands: string[];
  installHint: string;
  /** Marketplace installs carry their own display metadata. */
  source?: "path" | "marketplace";
  extensionId?: string;
  version?: string;
  installedAt?: string;
  displayName?: string;
  /** Explicit argv. For Node entrypoints the script must be the first item. */
  args?: string[];
  env?: Record<string, string>;
  /** Existence check for launcher-based specs (Node scripts, shell wrappers). */
  entryPath?: string;
  /** Human-readable command shown in Settings. */
  commandLabel?: string;
}

/**
 * LSP is deliberately bring-your-own-server. Jin detects the user's toolchain
 * and the language servers bundled in VS Code Marketplace extensions; it never
 * executes an extension's activation code.
 */
export const LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [
  {
    id: "typescript",
    language: "TypeScript / React",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    commands: ["typescript-language-server", "vtsls"],
    installHint:
      "npm install -g typescript-language-server typescript (or install a server extension from the Marketplace)",
  },
  {
    id: "vue",
    language: "Vue",
    extensions: [".vue"],
    commands: ["vue-language-server", "volar-server"],
    installHint:
      "npm install -g @vue/language-server (or install Vue - Official from the Marketplace)",
  },
  {
    id: "python",
    language: "Python",
    extensions: [".py"],
    commands: ["pyright-langserver", "pylsp"],
    installHint:
      "pip install pyright (or install a Python language server extension from the Marketplace)",
  },
  {
    id: "java",
    language: "Java",
    extensions: [".java"],
    commands: ["jdtls", "java-language-server"],
    installHint:
      "Install Eclipse JDT Language Server (jdtls) and put `jdtls` on PATH, or install Language Support for Java from the Marketplace",
  },
  {
    id: "kotlin",
    language: "Kotlin",
    extensions: [".kt", ".kts"],
    commands: ["kotlin-language-server"],
    installHint:
      "Download fwcd/kotlin-language-server and put `kotlin-language-server` on PATH",
  },
  {
    id: "go",
    language: "Go",
    extensions: [".go"],
    commands: ["gopls"],
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "rust",
    language: "Rust",
    extensions: [".rs"],
    commands: ["rust-analyzer"],
    installHint:
      "rustup component add rust-analyzer, or install rust-analyzer from the Marketplace",
  },
  {
    id: "cpp",
    language: "C / C++",
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx"],
    commands: ["clangd"],
    installHint:
      "Install clangd from your compiler toolchain, or install C/C++ from the Marketplace",
  },
];

function commandExists(command: string): boolean {
  if (existsSync(command)) return true;
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(finder, [command], {
      stdio: "ignore",
      timeout: 2000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function covers(spec: LanguageServerSpec, extensions: ReadonlySet<string>): boolean {
  return (
    extensions.size === 0 ||
    spec.extensions.some((extension) => extensions.has(extension))
  );
}

function availableCommand(spec: LanguageServerSpec): string | null {
  if (spec.entryPath) {
    return existsSync(spec.entryPath) ? spec.commands[0] ?? null : null;
  }
  return spec.commands.find(commandExists) ?? null;
}

function statusFor(
  spec: LanguageServerSpec,
  found: string | null,
): LspStatus {
  const marketplace = spec.source === "marketplace";
  const server = marketplace
    ? `${spec.displayName ?? spec.id}${spec.version ? ` v${spec.version}` : ""}`
    : found ?? spec.commands[0] ?? spec.id;
  return {
    id: spec.id,
    language: spec.language,
    server,
    command:
      spec.commandLabel ??
      (marketplace ? spec.entryPath ?? spec.commands[0] ?? spec.id : spec.commands.join(" | ")),
    status: found ? "available" : "missing",
    installHint: spec.installHint,
    detail: marketplace
      ? found
        ? thisMarketplaceDetail(spec)
        : "The installed VS Code extension no longer contains its language-server entry."
      : found
        ? `Found ${found} on PATH`
        : "No language server found on PATH; scanning falls back to structural analysis.",
    ...(marketplace
      ? {
          source: "marketplace" as const,
          extensionId: spec.extensionId,
          version: spec.version,
          extensions: spec.extensions,
          installedAt: spec.installedAt,
        }
      : { source: "path" as const, extensions: spec.extensions }),
  };
}

function thisMarketplaceDetail(spec: LanguageServerSpec): string {
  const origin = spec.extensionId ? ` from ${spec.extensionId}` : "";
  return `Standalone language server${origin}${spec.version ? ` v${spec.version}` : ""}, downloaded from the VS Code Marketplace.`;
}

export function detectLanguageServers(
  files: readonly string[] = [],
  installed: readonly LanguageServerSpec[] = [],
): LspStatus[] {
  const extensions = new Set(
    files
      .map((file) => {
        const index = file.lastIndexOf(".");
        return index >= 0 ? file.slice(index).toLowerCase() : "";
      })
      .filter(Boolean),
  );
  const statuses: LspStatus[] = [];
  const covered = new Set<string>();

  // Explicit Marketplace installs win over PATH duplicates. This avoids running
  // two servers for the same language during one scan.
  for (const spec of installed) {
    if (!covers(spec, extensions)) continue;
    if (spec.extensions.some((extension) => covered.has(extension))) continue;
    const found = availableCommand(spec);
    statuses.push(statusFor(spec, found));
    if (found) {
      for (const extension of spec.extensions) covered.add(extension);
    }
  }

  for (const spec of LANGUAGE_SERVERS) {
    if (!covers(spec, extensions)) continue;
    if (spec.extensions.every((extension) => covered.has(extension))) continue;
    statuses.push(statusFor(spec, availableCommand(spec)));
  }

  return statuses;
}

export function languageServerSpecFor(
  status: LspStatus,
  installed: readonly LanguageServerSpec[] = [],
): LanguageServerSpec | null {
  return (
    installed.find((spec) => spec.id === status.id) ??
    LANGUAGE_SERVERS.find((spec) => spec.id === status.id) ??
    null
  );
}

export function languageServerStatusFor(
  language: string,
  files: readonly string[] = [],
  installed: readonly LanguageServerSpec[] = [],
): LspStatus | null {
  return (
    detectLanguageServers(files, installed).find(
      (status) =>
        status.language.toLowerCase().includes(language.toLowerCase()) ||
        status.id === language.toLowerCase(),
    ) ?? null
  );
}
