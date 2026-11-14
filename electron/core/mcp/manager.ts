import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpCallResult, McpServerInfo } from "../../../shared/ipc";

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
      typeof tool === "object" &&
      tool !== null &&
      typeof (tool as { name?: unknown }).name === "string"
        ? (tool as { name: string }).name
        : "",
    )
    .filter(Boolean);
}

/** Extract per-tool description + JSON schema from a tools/list payload. */
export function toolMetadata(
  result: unknown,
): Map<string, { description: string; inputSchema: Record<string, unknown> }> {
  const meta = new Map<string, { description: string; inputSchema: Record<string, unknown> }>();
  if (typeof result !== "object" || result === null) return meta;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return meta;
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const record = tool as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name) continue;
    meta.set(record.name, {
      description: typeof record.description === "string" ? record.description : "",
      inputSchema:
        typeof record.inputSchema === "object" && record.inputSchema !== null
          ? (record.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    });
  }
  return meta;
}

function parseStdioResponse(line: string): JsonRpcResponse | null {
  try {
    const parsed = JSON.parse(line) as JsonRpcResponse;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function stdioRequest(
  root: string,
  config: McpServerConfig,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 6000,
): Promise<unknown> {
  if (!config.command) throw new Error("stdio server requires a command");
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(config.command as string, config.args ?? [], {
      cwd: root,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `MCP ${method} timed out after ${timeoutMs}ms${stderr ? `: ${stderr.slice(-300)}` : ""}`,
        ),
      );
    }, timeoutMs);
    const send = (value: unknown): void => {
      try {
        child.stdin.write(`${JSON.stringify(value)}\n`);
      } catch {
        finish(new Error("MCP process closed stdin"));
      }
    };
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
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method, params });
        } else if (response.id === 2) {
          if (response.error) {
            finish(new Error(response.error.message ?? `MCP ${method} failed`));
            return;
          }
          finish(null, response.result);
          return;
        } else if (response.error && response.id === undefined) {
          finish(new Error(response.error.message ?? "MCP server error"));
        }
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
          new Error(
            `MCP server exited before ${method}${code === null ? "" : ` (code ${code})`}${stderr ? `: ${stderr.slice(-300)}` : ""}`,
          ),
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

async function stdioToolsRaw(
  root: string,
  config: McpServerConfig,
  timeoutMs = 6000,
): Promise<unknown> {
  return stdioRequest(root, config, "tools/list", {}, timeoutMs);
}

function eventStreamData(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

async function remoteRequest(
  config: McpServerConfig,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<unknown> {
  if (!config.url) throw new Error("remote MCP server requires a url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const request = async (
    id: number,
    requestMethod: string,
    requestParams: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ response: Response; json: JsonRpcResponse }> => {
    const response = await fetch(config.url as string, {
      method: "POST",
      headers: sessionId ? { ...headers, "mcp-session-id": sessionId } : headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method: requestMethod, params: requestParams }),
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
    const result = await request(2, method, params, sessionId);
    if (result.json.error) throw new Error(result.json.error.message ?? `MCP ${method} failed`);
    return result.json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function remoteToolsRaw(config: McpServerConfig, timeoutMs = 8000): Promise<unknown> {
  return remoteRequest(config, "tools/list", {}, timeoutMs);
}

/**
 * MCP manager. Configured servers are connected lazily for a tools snapshot;
 * enabling a server never opens an approval dialog. Every refresh is audited in
 * `.jin/cache/mcp-audit.jsonl`.
 */
export class McpManager {
  private readonly root: string;
  private cache: McpServerInfo[] = [];
  /** Description + input schema per `server\u0000tool`, from tools/list. */
  private toolMeta = new Map<
    string,
    { description: string; inputSchema: Record<string, unknown> }
  >();

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
        const rawTools =
          base.transport === "stdio"
            ? await stdioToolsRaw(this.root, server)
            : await remoteToolsRaw(server);
        const tools = toolNames(rawTools);
        for (const [toolName, meta] of toolMetadata(rawTools)) {
          this.toolMeta.set(`${name}\u0000${toolName}`, meta);
        }
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

  /**
   * Invoke one MCP tool. Enabling a server never requires approval, but every
   * call is audited with its server, tool and outcome. Arguments are passed
   * through unchanged as MCP `arguments`.
   */
  async call(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<McpCallResult> {
    const config = readConfig(this.root).mcpServers?.[serverName];
    if (!config) throw new Error(`Unknown MCP server: ${serverName}`);
    if (config.disabled) throw new Error(`MCP server is disabled: ${serverName}`);
    const started = Date.now();
    try {
      const result =
        transportFor(config) === "stdio"
          ? await stdioRequest(
              this.root,
              config,
              "tools/call",
              { name: toolName, arguments: args },
              timeoutMs,
            )
          : await remoteRequest(
              config,
              "tools/call",
              { name: toolName, arguments: args },
              timeoutMs,
            );
      const record =
        typeof result === "object" && result !== null
          ? (result as { isError?: unknown; content?: unknown })
          : null;
      const callResult: McpCallResult = {
        server: serverName,
        tool: toolName,
        isError: record?.isError === true,
        content: record?.content ?? result,
        durationMs: Date.now() - started,
      };
      audit(this.root, {
        server: serverName,
        action: "tools/call",
        tool: toolName,
        isError: callResult.isError,
        durationMs: callResult.durationMs,
      });
      return callResult;
    } catch (error) {
      audit(this.root, {
        server: serverName,
        action: "tools/call",
        tool: toolName,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
      throw error;
    }
  }

  /**
   * MCP tools as first-class agent tools, namespaced `mcp__server__tool`.
   * Descriptions and input schemas come from `tools/list`; a server in error
   * or disabled state contributes no tools. The returned call helpers audit
   * through `call()` and serialize MCP results to plain text for the model.
   */
  agentTools(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    call: (args: Record<string, unknown>) => Promise<string>;
  }> {
    const tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      call: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    for (const server of this.cache) {
      if (server.status !== "ready") continue;
      for (const toolName of server.tools) {
        const meta = this.toolMeta.get(`${server.name}\u0000${toolName}`);
        tools.push({
          name: `mcp__${server.name}__${toolName}`,
          description:
            meta?.description?.slice(0, 800) || `MCP tool ${toolName} from server ${server.name}.`,
          parameters: meta?.inputSchema ?? { type: "object", properties: {} },
          call: async (args: Record<string, unknown>) => {
            const result = await this.call(server.name, toolName, args);
            return mcpResultText(result);
          },
        });
      }
    }
    return tools;
  }
}

/** Serialize an MCP call result into model-readable text. */
function mcpResultText(result: McpCallResult): string {
  if (result.isError) {
    const detail = JSON.stringify(result.content).slice(0, 600);
    return `Error: ${detail}`;
  }
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
          ? (((part as { text?: unknown }).text as string | undefined) ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
    return text || JSON.stringify(content).slice(0, 2_000);
  }
  return JSON.stringify(content, null, 2).slice(0, 4_000);
}
