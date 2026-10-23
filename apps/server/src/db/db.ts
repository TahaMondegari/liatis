import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.js";

export type Row = Record<string, unknown>;

/**
 * Thin wrapper around Node's built-in SQLite (node:sqlite).
 * Durable store for chats, runs/checkpoints, approvals, audit, incidents,
 * patrol state and model usage. Single-process: cross-process exclusion for
 * patrol uses DB lease rows (see monitor/patrol.ts), not in-memory locks.
 */
export class Db {
  readonly raw: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const current = Number((this.raw.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]!);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  private depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  kvGet<T>(key: string): T | null {
    const r = this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
    return r ? (JSON.parse(r.value) as T) : null;
  }
  kvSet(key: string, value: unknown): void {
    this.run("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  close(): void {
    this.raw.close();
  }
}

export const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string" || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
