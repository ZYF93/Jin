import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { translate, type Language, type MessageKey, type TranslationParams } from "../../../shared/i18n";

const ATTRIBUTE_LINE = ".jin/wal.jsonl merge=jin-wal";
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));

function quoteCommandPart(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

interface MergeDriverCommand {
  command: string;
  source: "bundled" | "development" | "override";
  path: string;
}

/**
 * Resolve the driver used by Git. Installed apps ship a self-contained
 * `merge-wal.cjs` next to the main bundle and run it through Electron's Node
 * mode, so teammates do not need Node.js or a Jin source checkout.
 */
function resolveDriver(root: string): MergeDriverCommand | null {
  const override = process.env.JIN_MERGE_DRIVER;
  if (override) {
    return { command: override, source: "override", path: override };
  }

  const bundled = join(MODULE_DIR, "merge-wal.cjs");
  const unpacked = bundled.replace(
    `${join("app.asar", "dist-electron")}`,
    `${join("app.asar.unpacked", "dist-electron")}`,
  );
  const driverPath = existsSync(unpacked) ? unpacked : bundled;
  if (existsSync(driverPath)) {
    const command = `ELECTRON_RUN_AS_NODE=1 ${quoteCommandPart(process.execPath)} ${quoteCommandPart(driverPath)} %O %A %B`;
    return { command, source: "bundled", path: driverPath };
  }

  const script = join(root, "scripts", "merge-wal.ts");
  if (existsSync(script)) {
    return {
      command: `vpx ${quoteCommandPart(script)} %O %A %B`,
      source: "development",
      path: script,
    };
  }
  return null;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasGit(root: string): boolean {
  return existsSync(join(root, ".git"));
}

function appendAttribute(root: string): boolean {
  const path = join(root, ".gitattributes");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split(/\r?\n/).some((line) => line.trim() === ATTRIBUTE_LINE)) {
    return false;
  }
  const suffix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${current}${suffix}${ATTRIBUTE_LINE}\n`, "utf8");
  return true;
}

/**
 * Install the Git merge driver in the current repository. The WAL is a single
 * append-only JSONL file; Git's textual merge cannot order causally related
 * records, so the driver performs a deterministic three-way union instead.
 *
 * In development the driver runs the TypeScript CLI through Vite+'s `vpx`.
 * `JIN_MERGE_DRIVER` can point at a packaged wrapper without changing this
 * module's behavior.
 */
export function installMergeDriver(
  root: string,
  language: Language = "en",
): { ok: boolean; message: string } {
  const t = (key: MessageKey, params?: TranslationParams): string =>
    translate(language, key, params);
  if (!hasGit(root)) {
    return {
      ok: false,
      message: t("merge.notGit"),
    };
  }
  try {
    const driver = resolveDriver(root);
    if (!driver) {
      return {
        ok: false,
        message: t("merge.driverMissing"),
      };
    }
    git(root, ["config", "merge.jin-wal.name", "Jin WAL merge driver"]);
    git(root, ["config", "merge.jin-wal.driver", driver.command]);
    const added = appendAttribute(root);
    const development = driver.source === "development";
    return {
      ok: true,
      message: t(
        added
          ? development
            ? "merge.installedDev"
            : "merge.installed"
          : development
            ? "merge.configuredDev"
            : "merge.configured",
      ),
    };
  } catch (error) {
    return {
      ok: false,
      message: t("merge.failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

export function mergeInstructions(root: string, language: Language = "en"): string {
  const driver = resolveDriver(root);
  const command = (
    driver?.command ?? "ELECTRON_RUN_AS_NODE=1 <jin> <merge-wal.cjs> %O %A %B"
  ).replace(/"/g, '\\"');
  const manualCommand =
    driver?.source === "bundled"
      ? `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${driver.path}" %O %A %B`
      : "vpx scripts/merge-wal.ts %O %A %B";
  const driverNote =
    driver?.source === "bundled" ? translate(language, "merge.bundledNote") : "";
  return translate(language, "merge.instructions", {
    command,
    manualCommand,
    driverNote,
  });
}
