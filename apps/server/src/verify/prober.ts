import { lookup, resolve4 } from "node:dns/promises";
import { connect } from "node:tls";
import type { DemoWorld } from "../demo/world.js";
import { isPrivateIp } from "../workspace/source.js";

export interface HttpProbe {
  url: string;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface Prober {
  readonly kind: "real" | "mock";
  http(url: string): Promise<HttpProbe>;
  tlsDaysLeft(host: string): Promise<{ daysLeft: number | null; error: string | null }>;
  dns(host: string): Promise<{ ok: boolean; addresses: string[]; error: string | null }>;
}

/** Real network prober. Only public HTTPS targets; private addresses are refused (SSRF guard). */
export class RealProber implements Prober {
  readonly kind = "real" as const;

  private async guard(host: string): Promise<void> {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("target resolves to a private address");
  }

  async http(url: string): Promise<HttpProbe> {
    const t0 = Date.now();
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("unsupported protocol");
      await this.guard(u.hostname);
      const res = await fetch(u, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "liara-deploy-agent-healthcheck/0.1" } });
      await res.body?.cancel();
      return { url, status: res.status, latencyMs: Date.now() - t0, error: null };
    } catch (e) {
      return { url, status: null, latencyMs: null, error: (e as Error).message.slice(0, 200) };
    }
  }

  async tlsDaysLeft(host: string) {
    try {
      await this.guard(host);
    } catch (e) {
      return { daysLeft: null, error: (e as Error).message };
    }
    return new Promise<{ daysLeft: number | null; error: string | null }>((resolve) => {
      const sock = connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        if (!cert?.valid_to) return resolve({ daysLeft: null, error: "no certificate" });
        resolve({ daysLeft: Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86400_000), error: sock.authorized ? null : String(sock.authorizationError ?? "") || null });
      });
      sock.on("error", (e) => resolve({ daysLeft: null, error: e.message }));
      sock.on("timeout", () => {
        sock.destroy();
        resolve({ daysLeft: null, error: "timeout" });
      });
    });
  }

  async dns(host: string) {
    try {
      const addresses = await resolve4(host);
      return { ok: addresses.length > 0, addresses, error: null };
    } catch (e) {
      return { ok: false, addresses: [], error: (e as Error).message };
    }
  }
}

/** Demo prober: answers from the simulated world; makes no network requests. */
export class MockProber implements Prober {
  readonly kind = "mock" as const;
  constructor(private world: DemoWorld) {}

  private appFor(url: string) {
    const host = new URL(url).hostname;
    const name = host.endsWith(".liara.run") ? host.replace(".liara.run", "") : [...this.world.domains.values()].find((d) => d.name === host)?.project;
    return name ? this.world.apps.get(name) : undefined;
  }

  async http(url: string): Promise<HttpProbe> {
    const app = this.appFor(url);
    if (!app) return { url, status: null, latencyMs: null, error: "ENOTFOUND" };
    if (app.scenario === "dns_error") return { url, status: null, latencyMs: null, error: "getaddrinfo ENOTFOUND" };
    if (app.scenario === "timeout") return { url, status: null, latencyMs: null, error: "The operation was aborted due to timeout" };
    const r = this.world.httpProbe(app, new URL(url).pathname);
    return { url, status: r.status, latencyMs: r.latencyMs, error: null };
  }

  async tlsDaysLeft(host: string) {
    const d = [...this.world.domains.values()].find((x) => x.name === host);
    return { daysLeft: d ? (d.certificatesStatus === "ACTIVE" ? 62 : null) : 80, error: d && d.certificatesStatus !== "ACTIVE" ? "certificate not issued" : null };
  }

  async dns(host: string) {
    const app = [...this.world.apps.values()].find((a) => host.startsWith(a.project_id));
    if (app?.scenario === "dns_error") return { ok: false, addresses: [], error: "ENOTFOUND" };
    return { ok: true, addresses: ["185.0.0.10"], error: null };
  }
}
