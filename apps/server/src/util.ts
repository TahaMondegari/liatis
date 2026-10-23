import { randomUUID, createHash } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** Injectable clock so tests/demo replay can fast-forward time. */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private t: number;
  constructor(start = Date.parse("2026-01-01T10:00:00Z")) {
    this.t = start;
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const iso = (d: Date = new Date()): string => d.toISOString();

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Deterministic JSON (sorted keys) for hashing approval scopes. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("aborted"));
    });
  });

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
export function faNum(n: number | string, opts: Intl.NumberFormatOptions = {}): string {
  if (typeof n === "string") return n.replace(/\d/g, (d) => FA_DIGITS[Number(d)]!);
  return new Intl.NumberFormat("fa-IR", opts).format(n);
}

export function faDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${faNum(s)} ثانیه`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${faNum(m)}:${faNum(String(r).padStart(2, "0"))}`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
