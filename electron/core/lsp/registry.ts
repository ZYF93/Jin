import { spawnSync } from "node:child_process";
import type { LspStatus } from "../../../shared/ipc";

export interface LanguageServerSpec {
  id: string;
  language: string;
  extensions: string[];
  commands: string[];
  installHint: string;
}

/**
 * LSP is deliberately bring-your-own-server. Jin detects the user's toolchain
 * and points at an install command; it does not download language runtimes
 * behind their back.
 */
export const LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [
  {
    id: "typescript",
    language: "TypeScript / React",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    commands: ["typescript-language-server", "vtsls"],
    installHint:
      "npm install -g typescript-language-server typescript (or use the vtsls VS Code extension)",
  },
  {
    id: "vue",
    language: "Vue",
    extensions: [".vue"],
    commands: ["vue-language-server", "volar-server"],
    installHint: "npm install -g @vue/language-server",
  },
  {
    id: "python",
    language: "Python",
    extensions: [".py"],
    commands: ["pyright-langserver", "pylsp"],
    installHint: "pip install pyright (or pip install python-lsp-server)",
  },
  {
    id: "java",
    language: "Java",
    extensions: [".java"],
    commands: ["jdtls", "java-language-server"],
    installHint:
      "Install Eclipse JDT Language Server (jdtls) and put `jdtls` on PATH",
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
];

function commandExists(command: string): boolean {
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

export function detectLanguageServers(
  files: readonly string[] = [],
): LspStatus[] {
  const extensions = new Set(
    files
      .map((file) => {
        const index = file.lastIndexOf(".");
        return index >= 0 ? file.slice(index).toLowerCase() : "";
      })
      .filter(Boolean),
  );
  return LANGUAGE_SERVERS.filter(
    (spec) =>
      extensions.size === 0 ||
      spec.extensions.some((extension) => extensions.has(extension)),
  ).map((spec) => {
    const found = spec.commands.find(commandExists);
    return {
      id: spec.id,
      language: spec.language,
      server: found ?? spec.commands[0] ?? spec.id,
      command: spec.commands.join(" | "),
      status: found ? "available" : "missing",
      installHint: spec.installHint,
      detail: found
        ? `Found ${found} on PATH`
        : "No language server found on PATH; scanning falls back to structural analysis.",
    };
  });
}

export function languageServerStatusFor(
  language: string,
  files: readonly string[] = [],
): LspStatus | null {
  return (
    detectLanguageServers(files).find(
      (status) =>
        status.language.toLowerCase().includes(language.toLowerCase()) ||
        status.id === language.toLowerCase(),
    ) ?? null
  );
}
