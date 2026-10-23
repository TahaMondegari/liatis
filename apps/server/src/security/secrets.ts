import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "../db/db.js";
import { registerSecret } from "./redact.js";

/**
 * Secret-safe flow for env values the user types (or the backend composes,
 * e.g. DATABASE_URL). Values are AES-256-GCM encrypted at rest, registered
 * with the redactor, and only substituted into Liara requests at execution
 * time via `{{secret:KEY}}` placeholders. They never enter run state, model
 * prompts, SSE events, audit records or approval scopes.
 */
export class SecretStore {
  private key: Buffer;
  constructor(
    private db: Db,
    keyFile: string,
  ) {
    if (existsSync(keyFile)) this.key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
    else {
      mkdirSync(dirname(keyFile), { recursive: true });
      this.key = randomBytes(32);
      writeFileSync(keyFile, this.key.toString("hex"), { mode: 0o600 });
    }
    this.db.raw.exec("CREATE TABLE IF NOT EXISTS secrets (scope TEXT NOT NULL, key TEXT NOT NULL, value_enc TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope, key))");
  }

  set(scope: string, key: string, value: string): void {
    registerSecret(value);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([c.update(value, "utf8"), c.final()]);
    const blob = Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
    this.db.run("INSERT INTO secrets(scope, key, value_enc, created_at) VALUES(?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET value_enc = excluded.value_enc", scope, key, blob, new Date().toISOString());
  }

  get(scope: string, key: string): string | null {
    const r = this.db.get<{ value_enc: string }>("SELECT value_enc FROM secrets WHERE scope = ? AND key = ?", scope, key);
    if (!r) return null;
    const buf = Buffer.from(r.value_enc, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const v = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
    registerSecret(v);
    return v;
  }

  keys(scope: string): string[] {
    return this.db.all<{ key: string }>("SELECT key FROM secrets WHERE scope = ?", scope).map((r) => r.key);
  }

  /** Replace {{secret:KEY}} placeholders anywhere inside a JSON-able value. */
  resolve<T>(scope: string, value: T): T {
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") {
        return v.replace(/\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}/g, (_m, k: string) => {
          const s = this.get(scope, k);
          if (s === null) throw new Error(`secret ${k} is not set`);
          return s;
        });
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object" && !(v instanceof Uint8Array)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(value) as T;
  }
}
