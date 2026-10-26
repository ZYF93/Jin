import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type GlassStrength = "off" | "subtle" | "medium" | "strong";
export type ThemeMode = "dark" | "light" | "system";

export interface JinConfig {
  version: 1;
  project: {
    name: string;
    languages: string[];
  };
  scan: {
    roots: string[];
    ignore: string[];
  };
  approval: {
    mode: "single";
    required: number;
  };
  ui: {
    theme: ThemeMode;
    glass: GlassStrength;
  };
}

export interface InitProjectOptions {
  name?: string;
  languages?: string[];
  force?: boolean;
}

export interface ProjectLocation {
  root: string;
  initialized: boolean;
}

export function jinDir(root: string): string {
  return join(root, ".jin");
}

export function configPath(root: string): string {
  return join(jinDir(root), "config.yaml");
}

export function walPath(root: string): string {
  return join(jinDir(root), "wal.jsonl");
}

export function cachePath(root: string): string {
  return join(jinDir(root), "cache");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : fallback;
}

function defaultScanRoots(root: string): string[] {
  const candidates = ["src", "electron", "shared"];
  const found = candidates.filter((candidate) => existsSync(join(root, candidate)));
  return found.length > 0 ? found : ["."];
}

export function defaultConfig(
  root: string,
  options: Pick<InitProjectOptions, "name" | "languages"> = {},
): JinConfig {
  return {
    version: 1,
    project: {
      name: options.name?.trim() || basename(root),
      languages: options.languages?.length
        ? [...new Set(options.languages)]
        : ["typescript", "react"],
    },
    scan: {
      roots: defaultScanRoots(root),
      ignore: [
        "node_modules",
        "dist",
        "dist-electron",
        ".git",
        ".jin/cache",
        "coverage",
      ],
    },
    approval: {
      mode: "single",
      required: 1,
    },
    ui: {
      theme: "dark",
      glass: "subtle",
    },
  };
}

function normalizeConfig(value: unknown, root: string): JinConfig {
  const fallback = defaultConfig(root);
  if (!isRecord(value)) return fallback;
  const project = isRecord(value.project) ? value.project : {};
  const scan = isRecord(value.scan) ? value.scan : {};
  const approval = isRecord(value.approval) ? value.approval : {};
  const ui = isRecord(value.ui) ? value.ui : {};
  const theme = ui.theme;
  const glass = ui.glass;
  const required = approval.required;

  return {
    version: 1,
    project: {
      name:
        typeof project.name === "string" && project.name.trim()
          ? project.name.trim()
          : fallback.project.name,
      languages: stringArray(project.languages, fallback.project.languages),
    },
    scan: {
      roots: stringArray(scan.roots, fallback.scan.roots),
      ignore: stringArray(scan.ignore, fallback.scan.ignore),
    },
    approval: {
      mode: "single",
      required:
        typeof required === "number" && Number.isInteger(required) && required > 0
          ? required
          : 1,
    },
    ui: {
      theme:
        theme === "dark" || theme === "light" || theme === "system"
          ? theme
          : fallback.ui.theme,
      glass:
        glass === "off" ||
        glass === "subtle" ||
        glass === "medium" ||
        glass === "strong"
          ? glass
          : fallback.ui.glass,
    },
  };
}

export function readConfig(root: string): JinConfig {
  const path = configPath(root);
  if (!existsSync(path)) {
    throw new Error(`No Jin config at ${path}. Run \`jin init\` first.`);
  }
  const text = readFileSync(path, "utf8");
  return normalizeConfig(parseYaml(text), root);
}

export function writeConfig(root: string, config: JinConfig): void {
  const text = `# Jin project configuration. Committed to Git.\n${stringifyYaml(
    config,
    { lineWidth: 0 },
  )}`;
  mkdirSync(jinDir(root), { recursive: true });
  writeFileSync(configPath(root), text, "utf8");
}

/**
 * Walk up from `start` looking for `.jin` (initialized) or `.git` (repo root).
 * An uninitialized repo is still a valid location; the UI can offer `jin init`.
 */
export function locateProject(start: string): ProjectLocation | null {
  let current = resolve(start);
  let gitRoot: string | null = null;
  for (;;) {
    if (existsSync(jinDir(current))) {
      return { root: current, initialized: true };
    }
    if (!gitRoot && existsSync(join(current, ".git"))) gitRoot = current;
    const parent = dirname(current);
    if (parent === current) {
      return gitRoot ? { root: gitRoot, initialized: false } : null;
    }
    current = parent;
  }
}
