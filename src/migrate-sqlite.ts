import { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";
import { empty, type Automation, type Card, type CardEvent, type Project } from "./db.ts";
import { writeJson } from "./fs.ts";

/**
 * One-time move from the SQLite file herdrboard used before its JSON store.
 * Writes `jsonPath` and renames the old database to `<db>.migrated` so it is
 * never read again. Delete this file once no board runs on SQLite.
 */
export function migrateSqlite(dbPath: string, jsonPath: string): boolean {
  if (existsSync(jsonPath) || !existsSync(dbPath)) return false;
  const db = new Database(dbPath, { readonly: true });
  const all = <T>(sql: string) => db.query(sql).all() as T[];
  const data = empty();
  data.projects = all<Project>("SELECT * FROM projects ORDER BY id");
  data.cards = all<Card>("SELECT * FROM cards ORDER BY id");
  data.events = all<CardEvent>("SELECT * FROM events ORDER BY id");
  data.automations = all<Automation>("SELECT * FROM automations ORDER BY id");
  const settings = db.query("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | null;
  data.settings = settings ? JSON.parse(settings.value) : null;
  const next = (rows: { id: number }[]) => Math.max(0, ...rows.map((r) => r.id)) + 1;
  data.next = { project: next(data.projects), card: next(data.cards), event: next(data.events), automation: next(data.automations) };
  db.close();
  writeJson(jsonPath, data);
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, `${dbPath}.migrated${suffix}`);
  return true;
}
