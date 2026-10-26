import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const APP_SCHEMA_VERSION = 1;

export interface AppDatabase {
  path: string;
  db: DatabaseSync;
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: string;
}

/**
 * Application-level data lives in Electron userData, never in the project.
 * The caller supplies the path so this module is testable without Electron.
 */
export function openAppDatabase(path: string): AppDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_projects (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT OR IGNORE INTO app_meta(key, value) VALUES('schema_version', ?)",
  ).run(String(APP_SCHEMA_VERSION));
  return { path, db };
}

export function closeAppDatabase(app: AppDatabase): void {
  app.db.close();
}

export function recordRecentProject(
  app: AppDatabase,
  project: { path: string; name: string; lastOpenedAt?: string },
): void {
  app.db
    .prepare(
      `INSERT INTO recent_projects(path, name, last_opened_at)
       VALUES(?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         name = excluded.name,
         last_opened_at = excluded.last_opened_at`,
    )
    .run(
      project.path,
      project.name,
      project.lastOpenedAt ?? new Date().toISOString(),
    );
}

export function listRecentProjects(
  app: AppDatabase,
  limit = 10,
): RecentProject[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = app.db
    .prepare(
      `SELECT path, name, last_opened_at
       FROM recent_projects
       ORDER BY last_opened_at DESC
       LIMIT ?`,
    )
    .all(safeLimit) as unknown as Array<{
    path: string;
    name: string;
    last_opened_at: string;
  }>;
  return rows.map((row) => ({
    path: row.path,
    name: row.name,
    lastOpenedAt: row.last_opened_at,
  }));
}

export function removeRecentProject(app: AppDatabase, path: string): void {
  app.db.prepare("DELETE FROM recent_projects WHERE path = ?").run(path);
}

export function getSetting(app: AppDatabase, key: string): string | null {
  const row = app.db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as unknown as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(
  app: AppDatabase,
  key: string,
  value: string,
): void {
  app.db
    .prepare(
      `INSERT INTO settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function deleteSetting(app: AppDatabase, key: string): void {
  app.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}
