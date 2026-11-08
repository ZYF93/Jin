import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { McpManager } from "./manager";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

function project(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "jin-mcp-"));
  roots.push(root);
  mkdirSync(join(root, ".jin"), { recursive: true });
  writeFileSync(join(root, ".jin", "mcp.json"), JSON.stringify(config, null, 2), "utf8");
  return root;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("McpManager", () => {
  it("lists and invokes a stdio tool with an audit trail", async () => {
    const root = mkdtempSync(join(tmpdir(), "jin-mcp-"));
    roots.push(root);
    mkdirSync(join(root, ".jin"), { recursive: true });
    writeFileSync(
      join(root, "mock-mcp.cjs"),
      `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  if (message.method === "initialize") respond({ capabilities: {}, serverInfo: { name: "mock" } });
  else if (message.method === "tools/list") respond({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] });
  else if (message.method === "tools/call") {
    const args = message.params && message.params.arguments ? message.params.arguments : {};
    respond({ content: [{ type: "text", text: "echo:" + String(args.text ?? "") }], isError: false });
  } else respond({});
});
`,
      "utf8",
    );
    writeFileSync(
      join(root, ".jin", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            mock: { command: process.execPath, args: [join(root, "mock-mcp.cjs")] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const manager = new McpManager(root);
    const listed = await manager.refresh();
    expect(listed).toEqual([
      expect.objectContaining({ name: "mock", status: "ready", tools: ["echo"] }),
    ]);

    const result = await manager.call("mock", "echo", { text: "hello" });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("echo:hello");

    const audit = readFileSync(join(root, ".jin", "cache", "mcp-audit.jsonl"), "utf8");
    expect(audit).toContain('"action":"tools/call"');
    expect(audit).toContain('"tool":"echo"');
  });

  it("lists and invokes a remote HTTP tool", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const message = JSON.parse(body) as {
          id?: number;
          method?: string;
          params?: { arguments?: { text?: string } };
        };
        const send = (result: unknown): void => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        };
        if (message.method === "initialize") send({ capabilities: {} });
        else if (message.method === "tools/list") {
          send({ tools: [{ name: "remote_echo", inputSchema: { type: "object" } }] });
        } else if (message.method === "tools/call") {
          send({
            content: [{ type: "text", text: `remote:${message.params?.arguments?.text ?? ""}` }],
            isError: false,
          });
        } else send({});
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const root = project({
      mcpServers: {
        remote: { url: `http://127.0.0.1:${port}/mcp` },
      },
    });

    const manager = new McpManager(root);
    const listed = await manager.refresh();
    expect(listed[0]).toEqual(
      expect.objectContaining({ name: "remote", transport: "http", tools: ["remote_echo"] }),
    );
    const result = await manager.call("remote", "remote_echo", { text: "hi" });
    expect(JSON.stringify(result.content)).toContain("remote:hi");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
