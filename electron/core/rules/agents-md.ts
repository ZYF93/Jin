import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AGENTS.md rule files. Jin injects two layers into every planning and
 * implementation prompt:
 * - a project-level `AGENTS.md` at the project root (owned by the repo),
 * - a global `AGENTS.md` in the app's userData directory (edited in Settings).
 */

export const AGENTS_MD_FILENAME = "AGENTS.md";

/** Hard budget so a huge rules file cannot blow up every prompt. */
const MAX_RULES_CHARS = 16_000;
const MAX_STORED_CHARS = 200_000;

export function globalAgentsMdPath(userDataDir: string): string {
  return join(userDataDir, AGENTS_MD_FILENAME);
}

export function projectAgentsMdPath(root: string): string {
  return join(root, AGENTS_MD_FILENAME);
}

function readAgentsFile(path: string): string {
  if (!existsSync(path)) return "";
  try {
    const content = readFileSync(path, "utf8");
    if (content.includes("\0")) return "";
    return content.length > MAX_RULES_CHARS
      ? `${content.slice(0, MAX_RULES_CHARS)}\n\n… [AGENTS.md truncated after ${MAX_RULES_CHARS} characters]`
      : content;
  } catch {
    return "";
  }
}

export function readGlobalAgentsMd(userDataDir: string): string {
  return readAgentsFile(globalAgentsMdPath(userDataDir));
}

export function readProjectAgentsMd(root: string): string {
  return readAgentsFile(projectAgentsMdPath(root));
}

/** Overwrite the global rules file; returns the absolute path written. */
export function writeGlobalAgentsMd(userDataDir: string, content: string): string {
  const path = globalAgentsMdPath(userDataDir);
  const clean = content.length > MAX_STORED_CHARS ? content.slice(0, MAX_STORED_CHARS) : content;
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(path, clean.endsWith("\n") || clean === "" ? clean : `${clean}\n`, "utf8");
  return path;
}

/**
 * Combined rules section for prompts. Empty when neither file exists, so
 * callers can skip the section entirely.
 */
export function combinedAgentRules(
  userDataDir: string,
  projectRoot: string,
): { project: string; global: string; combined: string } {
  const project = readProjectAgentsMd(projectRoot);
  const global = readGlobalAgentsMd(userDataDir);
  const sections: string[] = [];
  if (project.trim()) {
    sections.push(`PROJECT RULES (AGENTS.md in the project root):\n${project.trim()}`);
  }
  if (global.trim()) {
    sections.push(`GLOBAL RULES (user-level AGENTS.md):\n${global.trim()}`);
  }
  return { project, global, combined: sections.join("\n\n") };
}
