"use client";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

const TOKEN_KEY = "liara-agent-token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: string | null,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const tok = getToken();
  if (tok) headers.set("Authorization", `Bearer ${tok}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers, body, cache: "no-store" });
  if (!res.ok) {
    let j: { error?: string; message?: string; detail?: string } = {};
    try {
      j = await res.json();
    } catch {
      /* not json */
    }
    if (res.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("liara-auth-required"));
    throw new ApiError(res.status, j.error ?? "HTTP", j.message ?? `خطای ${res.status}`, j.detail ?? null);
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? res.json() : res.text()) as Promise<T>;
}

export const post = <T>(path: string, json?: unknown) => api<T>(path, { method: "POST", json: json ?? {} });
export const put = <T>(path: string, json?: unknown) => api<T>(path, { method: "PUT", json: json ?? {} });

export async function upload(file: File): Promise<{ uploadId: string; name: string; bytes: number }> {
  const fd = new FormData();
  fd.append("file", file);
  return api("/api/uploads", { method: "POST", body: fd });
}

export function eventsUrl(chatId: string | null, after: number): string {
  const u = new URL(`${API_URL}/api/events`);
  if (chatId) u.searchParams.set("chatId", chatId);
  if (after) u.searchParams.set("after", String(after));
  const t = getToken();
  if (t) u.searchParams.set("token", t);
  return u.toString();
}
