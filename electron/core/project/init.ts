import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureWalFile } from "../wal/io";
import {
  cachePath,
  configPath,
  defaultConfig,
  jinDir,
  readConfig,
  walPath,
  writeConfig,
  type InitProjectOptions,
  type JinConfig,
} from "./config";

export interface InitProjectResult {
  root: string;
  jinDir: string;
  walPath: string;
  config: JinConfig;
  created: boolean;
}

const JIN_GITIGNORE = "cache/\n*.tmp\n";

/**
 * Initialize `.jin/` idempotently. `force` refreshes config but never truncates
 * the WAL or deletes the cache: history is the one thing init must not destroy.
 */
export function initProject(
  root: string,
  options: InitProjectOptions = {},
): InitProjectResult {
  const dir = jinDir(root);
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  mkdirSync(cachePath(root), { recursive: true });

  const gitignore = join(dir, ".gitignore");
  if (options.force || !existsSync(gitignore)) {
    writeFileSync(gitignore, JIN_GITIGNORE, "utf8");
  }

  ensureWalFile(walPath(root));

  const shouldWriteConfig = options.force || !existsSync(configPath(root));
  const config = shouldWriteConfig
    ? defaultConfig(root, options)
    : readConfig(root);
  if (shouldWriteConfig) writeConfig(root, config);

  return {
    root,
    jinDir: dir,
    walPath: walPath(root),
    config,
    created,
  };
}
