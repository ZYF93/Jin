import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScanMember } from "../scan/scanner";
import type { LanguageServerSpec } from "./registry";

export interface LspFactSymbol {
  path: string;
  name: string;
  kind: ScanMember["kind"];
  /** 1-based and present only when the language server returned a source range. */
  line?: number;
  /** 1-based. */
  character?: number;
  detail: string;
}

export interface LspFactDiagnostic {
  path: string;
  line: number;
  character: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source: string;
}

export interface LspServerFacts {
  id: string;
  server: string;
  symbols: number;
  diagnostics: number;
  error?: string;
}

export interface LspFacts {
  symbols: LspFactSymbol[];
  diagnostics: LspFactDiagnostic[];
  servers: LspServerFacts[];
  collectedAt: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const SYMBOL_KINDS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

export function symbolKind(kind: number): string {
  return SYMBOL_KINDS[kind] ?? "symbol";
}

function facetKind(kind: number): ScanMember["kind"] | null {
  const name = symbolKind(kind);
  if (name === "file" || name === "module" || name === "package" || name === "namespace") {
    return null;
  }
  if (name === "class" || name === "interface" || name === "struct" || name === "enum") {
    return "field";
  }
  if (name === "property" || name === "variable" || name === "constant" || name === "field") {
    return "property";
  }
  return "method";
}

function languageId(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".tsx") return "typescriptreact";
  if (extension === ".jsx") return "javascriptreact";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "javascript";
  if (extension === ".vue") return "vue";
  if (extension === ".py") return "python";
  if (extension === ".java") return "java";
  if (extension === ".kt" || extension === ".kts") return "kotlin";
  if (extension === ".go") return "go";
  return "typescript";
}

function serverArgs(spec: LanguageServerSpec, command: string): string[] {
  if (spec.args) return spec.args;
  const base = command.split(/[\\/]/).pop() ?? command;
  if (spec.id === "typescript" || spec.id === "vue") return ["--stdio"];
  if (spec.id === "python" && base.includes("pyright")) return ["--stdio"];
  return [];
}

function frame(message: Record<string, unknown>): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

interface RawSymbol {
  name?: unknown;
  kind?: unknown;
  detail?: unknown;
  range?: { start?: { line?: unknown; character?: unknown } };
  selectionRange?: { start?: { line?: unknown; character?: unknown } };
  location?: { range?: { start?: { line?: unknown; character?: unknown } } };
  containerName?: unknown;
  children?: unknown;
}

/** Flatten LSP DocumentSymbol/SymbolInformation responses into scan members. */
export function flattenDocumentSymbols(path: string, value: unknown, limit = 80): LspFactSymbol[] {
  const result: LspFactSymbol[] = [];
  const seen = new Set<string>();
  const visit = (raw: unknown): void => {
    if (result.length >= limit || !Array.isArray(raw)) return;
    for (const item of raw) {
      if (result.length >= limit) break;
      if (typeof item !== "object" || item === null) continue;
      const symbol = item as RawSymbol;
      if (typeof symbol.name !== "string" || typeof symbol.kind !== "number") continue;
      const kind = facetKind(symbol.kind);
      if (kind) {
        const start =
          symbol.selectionRange?.start ??
          symbol.range?.start ??
          symbol.location?.range?.start ??
          {};
        const line = typeof start.line === "number" ? start.line + 1 : undefined;
        const character = typeof start.character === "number" ? start.character + 1 : undefined;
        const key = `${kind}:${symbol.name}:${line ?? "unknown"}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({
            path,
            name: symbol.name,
            kind,
            ...(line ? { line } : {}),
            ...(character ? { character } : {}),
            detail:
              typeof symbol.detail === "string"
                ? symbol.detail
                : typeof symbol.containerName === "string"
                  ? `${symbolKind(symbol.kind)} in ${symbol.containerName}`
                  : symbolKind(symbol.kind),
          });
        }
      }
      if (Array.isArray(symbol.children)) visit(symbol.children);
    }
  };
  visit(value);
  return result;
}

interface DiagnosticParams {
  uri?: unknown;
  diagnostics?: unknown;
}

interface RawDiagnostic {
  range?: { start?: { line?: unknown; character?: unknown } };
  severity?: unknown;
  message?: unknown;
  source?: unknown;
}

function severityName(value: unknown): LspFactDiagnostic["severity"] {
  if (value === 2) return "warning";
  if (value === 3) return "info";
  if (value === 4) return "hint";
  return "error";
}

function filePathFromUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
  } catch {
    return null;
  }
}

/**
 * Minimal JSON-RPC LSP client over stdio. Jin only needs document symbols and
 * published diagnostics; semantic layer/domain decisions stay with the LLM and
 * the human review step.
 */
export class LspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly root: string;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly diagnostics = new Map<string, LspFactDiagnostic[]>();
  private readonly diagnosticSeen = new Set<string>();
  private closed = false;
  private readonly workspaceUri: string;

  private constructor(child: ChildProcessWithoutNullStreams, root: string) {
    this.child = child;
    this.root = root;
    this.workspaceUri = pathToFileURL(root).href;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.on("exit", () => this.failAll(new Error("LSP server exited")));
    child.on("error", (error) => this.failAll(error));
  }

  static async start(
    root: string,
    spec: LanguageServerSpec,
    command: string,
    timeoutMs = 10_000,
  ): Promise<LspClient> {
    const child = spawn(command, serverArgs(spec, command), {
      cwd: root,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    }) as ChildProcessWithoutNullStreams;
    const client = new LspClient(child, root);
    try {
      await client.request(
        "initialize",
        {
          processId: process.pid,
          rootPath: root,
          rootUri: client.workspaceUri,
          workspaceFolders: [{ uri: client.workspaceUri, name: "jin-project" }],
          capabilities: {
            textDocument: {
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              publishDiagnostics: { relatedInformation: false },
            },
            workspace: {
              workspaceFolders: true,
              configuration: true,
            },
          },
          clientInfo: { name: "jin", version: "0.1.0" },
        },
        timeoutMs,
      );
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      const fallbackEnd = this.buffer.indexOf("\n\n");
      const end = headerEnd >= 0 ? headerEnd : fallbackEnd;
      if (end < 0) return;
      const header = this.buffer.slice(0, end).toString("utf8");
      const separatorLength = headerEnd >= 0 ? 4 : 2;
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(end + separatorLength);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = end + separatorLength;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.slice(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.slice(bodyStart + length);
      try {
        this.handle(JSON.parse(body) as Record<string, unknown>);
      } catch {
        // Ignore malformed frames; a broken server should not crash the app.
      }
    }
  }

  private handle(message: Record<string, unknown>): void {
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = message.error as { message?: unknown };
        pending.reject(
          new Error(typeof error.message === "string" ? error.message : "LSP request failed"),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.method === "textDocument/publishDiagnostics") {
      this.acceptDiagnostics(message.params as DiagnosticParams);
      return;
    }
    if (id !== null) this.respondToServer(id, message.method, message.params);
  }

  private respondToServer(id: number, method: string, params: unknown): void {
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const items = (params as { items?: unknown } | undefined)?.items;
      result = Array.isArray(items) ? items.map(() => null) : [];
    } else if (method === "workspace/workspaceFolders") {
      result = [{ uri: this.workspaceUri, name: "jin-project" }];
    }
    this.write({ jsonrpc: "2.0", id, result });
  }

  private acceptDiagnostics(params: DiagnosticParams | undefined): void {
    if (!params || typeof params.uri !== "string") return;
    const path = filePathFromUri(params.uri);
    const relative = path
      ? path.startsWith(this.root)
        ? path
            .slice(this.root.length)
            .replace(/^[/\\]/, "")
            .replace(/\\/g, "/")
        : null
      : null;
    if (!relative) return;
    const list: LspFactDiagnostic[] = [];
    if (Array.isArray(params.diagnostics)) {
      for (const raw of params.diagnostics) {
        if (typeof raw !== "object" || raw === null) continue;
        const diagnostic = raw as RawDiagnostic;
        const start = diagnostic.range?.start ?? {};
        list.push({
          path: relative,
          line: typeof start.line === "number" ? start.line + 1 : 1,
          character: typeof start.character === "number" ? start.character + 1 : 1,
          severity: severityName(diagnostic.severity),
          message: typeof diagnostic.message === "string" ? diagnostic.message : "Diagnostic",
          source: typeof diagnostic.source === "string" ? diagnostic.source : "",
        });
      }
    }
    this.diagnostics.set(relative, list);
    this.diagnosticSeen.add(relative);
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(frame(message));
    } catch {
      // The pending request will time out or reject on exit.
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 8000,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("LSP client is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async documentSymbols(
    path: string,
    timeoutMs = 4000,
  ): Promise<{ symbols: LspFactSymbol[]; diagnosticsSeen: boolean }> {
    const absolute = join(this.root, path);
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      return { symbols: [], diagnosticsSeen: false };
    }
    const uri = pathToFileURL(absolute).href;
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: languageId(path),
        version: 1,
        text,
      },
    });
    const result = await this.request(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      timeoutMs,
    );
    return {
      symbols: flattenDocumentSymbols(path, result),
      diagnosticsSeen: this.diagnosticSeen.has(path),
    };
  }

  currentDiagnostics(path?: string): LspFactDiagnostic[] {
    if (path) return [...(this.diagnostics.get(path) ?? [])];
    return [...this.diagnostics.values()].flat();
  }

  async waitForDiagnostics(timeoutMs = 600): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }

  close(): void {
    if (this.closed) return;
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method: "shutdown", params: {} });
    this.notify("exit", {});
    setTimeout(() => {
      try {
        this.child.kill();
      } catch {
        // already gone
      }
    }, 250).unref();
    this.closed = true;
  }
}
