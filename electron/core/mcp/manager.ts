import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerInfo } from "../../../shared/ipc";

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: "stdio" | "http" | "sse";
  disabled?: boolean;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function readConfig(root: string): McpConfig {
  const path = join(root, ".jin", "mcp.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as McpConfig;
    }
  } catch {
    return {};
  }
  return {};
}

function transportFor(config: McpServerConfig): McpServerInfo["transport"] {
  if (config.transport) return config.transport;
  if (config.url) return config.url.endsWith("/sse") ? "sse" : "http";
  return "stdio";
}

function targetFor(config: McpServerConfig): string {
  if (config.url) return config.url;
  return [config.command ?? "", ...(config.args ?? [])].join(" ").trim();
}

function audit(root: string, entry: Record<string, unknown>): void {
  try {
    const dir = join(root, ".jin", "cache");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "mcp-audit.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch {
    // Audit is best-effort; a read-only cache must not break the app.
  }
}

function toolNames(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) =>
      typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string"
        ? (tool as { name: string }).name
        : "",
    )
    .filter(Boolean);
}

function parseStdioResponse(line: string): JsonRpcResponse | null {
  try {
    const parsed = JSON.parse(line) as JsonRpcResponse;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function stdioTools(
  root: string,
  config: McpServerConfig,
  timeoutMs = 6000,
): Promise<string[]> {
  if (!config.command) throw new Error("stdio server requires a command");
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(config.command as string, config.args ?? [], {
      cwd: root,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, tools: string[] = []): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      if (error) reject(error);
      else resolve(tools);
    };
    const timer = setTimeout(() => {
      finish(new Error(`MCP initialize timed out after ${timeoutMs}ms${stderr ? `: ${stderr.slice(-300)}` : ""}`));
    }, timeoutMs);
    const send = (value: unknown): void => {
      try {
        child.stdin.write(`${JSON.stringify(value)}\n`);
      } catch {
        finish(new Error("MCP process closed stdin"));
      }
    };
    let initialized = false;
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const response = parseStdioResponse(line);
        if (!response) continue;
        if (response.id === 1) {
          if (response.error) {
            finish(new Error(response.error.message ?? "MCP initialize failed"));
            return;
          }
          initialized = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (response.id === 2) {
          if (response.error) {
            finish(new Error(response.error.message ?? "MCP tools/list failed"));
            return;
          }
          finish(null, toolNames(response.result));
        } else if (response.error && response.id === undefined) {
          finish(new Error(response.error.message ?? "MCP server error"));
        }
        if (initialized && response.id === 2) return;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(
          new Error(`MCP server exited before tools/list${code === null ? "" : ` (code ${code})`}${stderr ? `: ${stderr.slice(-300)}` : ""}`),
        );
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "jin", version: "0.1.0" },
      },
    });
  });
}

function eventStreamData(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

async function remoteTools(
  config: McpServerConfig,
  timeoutMs = 8000,
): Promise<string[]> {
  if (!config.url) throw new Error("remote MCP server requires a url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const request = async (
    id: number,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ response: Response; json: JsonRpcResponse }> => {
    const response = await fetch(config.url as string, {
      method: "POST",
      headers: sessionId ? { ...headers, "mcp-session-id": sessionId } : headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      const data = eventStreamData(text);
      const json = data
        .map((item) => {
          try {
            return JSON.parse(item) as JsonRpcResponse;
          } catch {
            return null;
          }
        })
        .find((item): item is JsonRpcResponse => item !== null && item.id === id);
      if (!json) throw new Error("MCP SSE response did not include the matching request id");
      return { response, json };
    }
    const json = (await response.json()) as JsonRpcResponse;
    return { response, json };
  };
  try {
    const init = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jin", version: "0.1.0" },
    });
    if (init.json.error) throw new Error(init.json.error.message ?? "MCP initialize failed");
    const sessionId = init.response.headers.get("mcp-session-id") ?? undefined;
    const list = await request(2, "tools/list", {}, sessionId);
    if (list.json.error) throw new Error(list.json.error.message ?? "MCP tools/list failed");
    return toolNames(list.json.result);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * MCP manager. Configured servers are connected lazily for a tools snapshot;
 * enabling a server never opens an approval dialog. Every refresh is audited in
 * `.jin/cache/mcp-audit.jsonl`.
 */
export class McpManager {
  private readonly root: string;
  private cache: McpServerInfo[] = [];

  constructor(root: string) {
    this.root = root;
    this.cache = this.configured();
  }

  configured(): McpServerInfo[] {
    const config = readConfig(this.root);
    return Object.entries(config.mcpServers ?? {}).map(([name, server]) => ({
      name,
      transport: transportFor(server),
      target: targetFor(server),
      status: server.disabled ? "disabled" : "configured",
      tools: [],
      error: null,
    }));
  }

  list(): McpServerInfo[] {
    return this.cache;
  }

  async refresh(): Promise<McpServerInfo[]> {
    const config = readConfig(this.root);
    const entries = Object.entries(config.mcpServers ?? {});
    const results: McpServerInfo[] = [];
    for (const [name, server] of entries) {
      const base: McpServerInfo = {
        name,
        transport: transportFor(server),
        target: targetFor(server),
        status: server.disabled ? "disabled" : "configured",
        tools: [],
        error: null,
      };
      if (server.disabled) {
        results.push(base);
        continue;
      }
      try {
        const tools =
          base.transport === "stdio"
            ? await stdioTools(this.root, server)
            : await remoteTools(server);
        results.push({ ...base, status: "ready", tools });
        audit(this.root, { server: name, action: "tools/list", tools });
      } catch (error) {
        results.push({
          ...base,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        audit(this.root, {
          server: name,
          action: "tools/list",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.cache = results;
    return results;
  }
}
