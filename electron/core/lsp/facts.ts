import { extname } from "node:path";
import type { LspStatus } from "../../../shared/ipc";
import {
  LspClient,
  type LspFactDiagnostic,
  type LspFactSymbol,
  type LspFacts,
  type LspServerFacts,
} from "./client";
import {
  languageServerSpecFor,
  type LanguageServerSpec,
} from "./registry";

export interface CollectLspFactsOptions {
  maxFilesPerServer?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** System plus Marketplace specs; defaults to the built-in PATH specs. */
  specs?: readonly LanguageServerSpec[];
}

function extensionOf(path: string): string {
  return extname(path).toLowerCase();
}

/**
 * Ask every available language server for document symbols and diagnostics.
 * Servers are started one at a time so a large polyglot repo does not spawn
 * six runtimes at once. Missing servers are a normal state, not an error.
 */
export async function collectLspFacts(
  root: string,
  files: readonly string[],
  statuses: readonly LspStatus[],
  options: CollectLspFactsOptions = {},
): Promise<LspFacts> {
  const maxFiles = options.maxFilesPerServer ?? 80;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const symbols: LspFactSymbol[] = [];
  const diagnostics: LspFactDiagnostic[] = [];
  const servers: LspServerFacts[] = [];

  for (const status of statuses) {
    if (options.signal?.aborted || Date.now() >= deadline) break;
    if (status.status !== "available") continue;
    const spec = languageServerSpecFor(status, options.specs ?? []);
    if (!spec) continue;
    const matching = files
      .filter((file) => spec.extensions.includes(extensionOf(file)))
      .slice(0, maxFiles);
    if (matching.length === 0) continue;

    let client: LspClient | null = null;
    let symbolCount = 0;
    let diagnosticCount = 0;
    let error: string | undefined;
    try {
      const remaining = Math.max(1000, deadline - Date.now());
      // Marketplace status.server is a display label (e.g. "Pylance v1"); the
      // actual launcher is the spec command.
      const command =
        status.source === "marketplace"
          ? spec.commands[0]
          : status.server || spec.commands[0];
      if (!command) continue;
      client = await LspClient.start(
        root,
        spec,
        command,
        Math.min(8000, remaining),
      );
      for (const path of matching) {
        if (options.signal?.aborted || Date.now() >= deadline) break;
        try {
          const result = await client.documentSymbols(
            path,
            Math.min(4000, Math.max(500, deadline - Date.now())),
          );
          symbols.push(...result.symbols);
          symbolCount += result.symbols.length;
        } catch (requestError) {
          error = requestError instanceof Error ? requestError.message : String(requestError);
          break;
        }
      }
      if (client) {
        await client.waitForDiagnostics(450);
        const found = client.currentDiagnostics();
        diagnostics.push(...found);
        diagnosticCount = found.length;
      }
    } catch (startError) {
      error = startError instanceof Error ? startError.message : String(startError);
    } finally {
      client?.close();
    }
    servers.push({
      id: status.id,
      server: status.server,
      symbols: symbolCount,
      diagnostics: diagnosticCount,
      ...(error ? { error } : {}),
    });
  }

  return {
    symbols,
    diagnostics,
    servers,
    collectedAt: new Date().toISOString(),
  };
}
