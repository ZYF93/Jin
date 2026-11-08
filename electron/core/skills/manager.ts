import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillInfo } from "../../../shared/ipc";

export interface SkillDocument {
  info: SkillInfo;
  content: string;
}

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: text };
  const header = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n+/, "");
  try {
    const parsed = parseYaml(header);
    return {
      data:
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
      body,
    };
  } catch {
    return { data: {}, body };
  }
}

function readSkill(path: string, scope: SkillInfo["scope"]): SkillDocument | null {
  try {
    const text = readFileSync(path, "utf8");
    const parsed = frontmatter(text);
    const directory = basename(join(path, ".."));
    const name =
      typeof parsed.data.name === "string" && parsed.data.name.trim()
        ? parsed.data.name.trim()
        : directory;
    const description =
      typeof parsed.data.description === "string" && parsed.data.description.trim()
        ? parsed.data.description.trim()
        : parsed.body.split("\n").find((line) => line.trim())?.slice(0, 300) ??
          "Project skill";
    return {
      info: { name, description, scope, path },
      content: parsed.body,
    };
  } catch {
    return null;
  }
}

function listDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .filter((directory) => {
        try {
          return statSync(join(directory, "SKILL.md")).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** User-level skill roots shared by Jin, agents, and cc-switch. */
export function defaultUserSkillRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".config", "jin", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".cc-switch", "skills"),
  ];
}

/**
 * Skills are local instruction/tool bundles. They are always available to the
 * agent and audited by the session; enabling one never opens an approval modal.
 *
 * Project skills win name collisions, followed by the user roots in priority
 * order. Symlinked duplicates are deduplicated by their resolved path.
 */
export class SkillManager {
  private readonly roots: Array<{ path: string; scope: SkillInfo["scope"] }>;

  constructor(
    projectRoot: string,
    userRoots: string | readonly string[] = defaultUserSkillRoots(),
  ) {
    const extra = typeof userRoots === "string" ? [userRoots] : userRoots;
    this.roots = [
      { path: join(projectRoot, ".jin", "skills"), scope: "project" },
      ...extra.map((path) => ({ path, scope: "user" as const })),
    ];
  }

  listDocuments(): SkillDocument[] {
    const seenPaths = new Set<string>();
    const seenNames = new Set<string>();
    const documents: SkillDocument[] = [];
    for (const root of this.roots) {
      for (const directory of listDirectories(root.path)) {
        const path = resolve(directory, "SKILL.md");
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
        const document = readSkill(path, root.scope);
        if (!document) continue;
        const name = document.info.name.toLowerCase();
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        documents.push(document);
      }
    }
    return documents.sort((left, right) =>
      left.info.name.localeCompare(right.info.name),
    );
  }

  list(): SkillInfo[] {
    return this.listDocuments().map((document) => document.info);
  }

  read(name: string): SkillDocument | null {
    return (
      this.listDocuments().find(
        (document) =>
          document.info.name.toLowerCase() === name.toLowerCase() ||
          basename(dirname(document.info.path)).toLowerCase() === name.toLowerCase(),
      ) ?? null
    );
  }

  promptFor(query: string, maxSkills = 2, maxChars = 5000): string {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_\u3400-\u9fff]+/g)
      .filter((term) => term.length > 2);
    const scored = this.listDocuments()
      .map((document) => {
        const haystack = `${document.info.name}\n${document.info.description}\n${document.content}`.toLowerCase();
        const score = terms.reduce(
          (sum, term) => sum + (haystack.includes(term) ? 1 : 0),
          0,
        );
        return { document, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSkills);
    if (scored.length === 0) return "";
    return scored
      .map(
        ({ document }) =>
          `### Skill: ${document.info.name}\n${document.info.description}\n\n${document.content.slice(0, Math.max(500, Math.floor(maxChars / scored.length)))}`,
      )
      .join("\n\n");
  }
}
