import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type HookEvent = "preToolUse" | "postToolUse" | "beforeImplement";

export interface HookRule {
  event: HookEvent;
  /** Regex matched against the tool name; empty means every tool. */
  matcher: string;
  command: string;
  /** Blocks the tool when the command exits non-zero (preToolUse only). */
  blockOnError?: boolean;
}

export interface HooksConfig {
  hooks: HookRule[];
}

const HOOK_EVENTS: ReadonlySet<HookEvent> = new Set([
  "preToolUse",
  "postToolUse",
  "beforeImplement",
]);

/** Parse `.jin/hooks.json`. Missing or malformed files yield an empty config. */
export function parseHooksConfig(text: string): HooksConfig {
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = (parsed as { hooks?: unknown }).hooks;
    if (!Array.isArray(list)) return { hooks: [] };
    const hooks: HookRule[] = [];
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const event = record.event;
      const command = record.command;
      if (typeof event !== "string" || !HOOK_EVENTS.has(event as HookEvent)) continue;
      if (typeof command !== "string" || !command.trim()) continue;
      hooks.push({
        event: event as HookEvent,
        matcher: typeof record.matcher === "string" ? record.matcher : "",
        command: command.slice(0, 4_000),
        ...(record.blockOnError === true ? { blockOnError: true } : {}),
      });
    }
    return { hooks };
  } catch {
    return { hooks: [] };
  }
}

export function loadHooksConfig(root: string): HooksConfig {
  const path = join(root, ".jin", "hooks.json");
  if (!existsSync(path)) return { hooks: [] };
  try {
    if (!statSync(path).isFile()) return { hooks: [] };
    return parseHooksConfig(readFileSync(path, "utf8"));
  } catch {
    return { hooks: [] };
  }
}

export interface HookRunOptions {
  root: string;
  event: HookEvent;
  tool?: string;
  args?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HookRunResult {
  /** Commands that were executed, in order. */
  ran: string[];
  blocked: boolean;
  message: string;
}

/**
 * Run the hooks registered for an event. Pre-tool hooks can veto a call by
 * exiting non-zero; post-tool hooks are informational and never block.
 */
export async function runHooks(options: HookRunOptions): Promise<HookRunResult> {
  const config = loadHooksConfig(options.root);
  const matches = config.hooks.filter((hook) => {
    if (hook.event !== options.event) return false;
    if (!hook.matcher.trim()) return true;
    if (!options.tool) return false;
    try {
      return new RegExp(hook.matcher).test(options.tool);
    } catch {
      return false;
    }
  });
  const ran: string[] = [];
  for (const hook of matches) {
    if (options.signal?.aborted) break;
    const args = JSON.stringify(options.args ?? {}).slice(0, 4_000);
    try {
      await execFileAsync(hook.command, {
        cwd: options.root,
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          JIN_HOOK_EVENT: options.event,
          JIN_TOOL: options.tool ?? "",
          JIN_TOOL_ARGS: args,
        },
      });
      ran.push(hook.command);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ran.push(hook.command);
      if (hook.blockOnError !== false && options.event === "preToolUse") {
        return { ran, blocked: true, message: `Hook blocked ${options.tool ?? "tool"}: ${detail}` };
      }
    }
  }
  return { ran, blocked: false, message: "" };
}

export interface CustomCommand {
  name: string;
  description: string;
  body: string;
}

/** Load `.jin/commands/*.md` slash commands. `$ARGUMENTS` is replaced by Jin. */
export function loadCustomCommands(root: string): CustomCommand[] {
  const dir = join(root, ".jin", "commands");
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const commands: CustomCommand[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const path = join(dir, file);
    try {
      if (!statSync(path).isFile()) continue;
      const text = readFileSync(path, "utf8");
      const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
      let description = "";
      let body = text;
      if (front) {
        for (const line of front[1].split("\n")) {
          const match = /^description:\s*(.+)$/.exec(line);
          if (match?.[1]) description = match[1].trim();
        }
        body = text.slice(front[0].length);
      }
      commands.push({ name: basename(file, ".md"), description, body: body.trim() });
    } catch {
      continue;
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

/** Replace `$ARGUMENTS` (and `$1`, `$2`) placeholders in a command body. */
export function expandArguments(body: string, args: string): string {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  return body
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\$(\d+)/g, (_match, index: string) => parts[Number(index) - 1] ?? "");
}
