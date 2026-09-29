import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProviderArchiveConfig {
  directory?: string;
  fetch?: typeof fetch;
  intervalMs?: number;
  key?: string;
  secret?: string;
  massiveKey?: string;
}
const HOSTS = new Set(["data.alpaca.markets", "paper-api.alpaca.markets", "data.sec.gov", "en.wikipedia.org", "api.massive.com"]);
/** GET-only evidence capture. Credentials are headers and never persisted. */
export class ProviderArchive {
  private pending = new Map<string, Promise<unknown>>();
  private failures = new Map<string, Error>();
  private suspended = new Set<string>();
  private turns = new Map<string, Promise<void>>();
  private next = new Map<string, number>();
  constructor(private config: ProviderArchiveConfig = {}) {}
  async get(input: string): Promise<unknown> {
    const url = new URL(input);
    if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username || url.password || url.port ||
        [...url.searchParams.keys()].some(k => /^(api[-_]?key|authorization|secret|access_token)$/i.test(k)))
      throw new Error("Invalid provider evidence URL");
    if (this.failures.has(input)) throw this.failures.get(input)!;
    const existing = this.pending.get(input);
    if (existing) return existing;
    const promise = this.read(url).catch(error => {
      const safe = error instanceof Error ? error : new Error("Provider unavailable");
      this.failures.set(input, safe);
      throw safe;
    });
    this.pending.set(input, promise);
    try { return await promise; }
    finally { if (this.config.directory) this.pending.delete(input); }
  }
  private async read(url: URL): Promise<unknown> {
    const file = this.config.directory
      ? join(this.config.directory, `${createHash("sha256").update(url.href).digest("hex")}.json`) : null;
    if (file) {
      try {
        const saved = JSON.parse(await readFile(file,"utf8"));
        if (saved.url !== url.href || !saved.observedAt || !("data" in saved))
          throw new Error("Invalid archived provider evidence");
        return saved.data;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (this.suspended.has(url.hostname)) throw new Error(`${url.hostname} suspended after provider failure`);
    const turn = (this.turns.get(url.hostname) ?? Promise.resolve()).then(async () => {
      const delay = Math.max(0, (this.next.get(url.hostname) ?? 0)-Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve,delay));
      this.next.set(url.hostname, Date.now() + (this.config.intervalMs ?? 350));
    });
    this.turns.set(url.hostname,turn);
    await turn;
    if (this.suspended.has(url.hostname)) throw new Error(`${url.hostname} suspended after provider failure`);
    const headers: Record<string,string> = {Accept:"application/json"};
    if (url.hostname.endsWith("alpaca.markets")) {
      const key = this.config.key ?? process.env.ALPACA_API_KEY;
      const secret = this.config.secret ?? process.env.ALPACA_API_SECRET;
      if (!key || !secret) throw new Error("Alpaca credentials are required");
      headers["APCA-API-KEY-ID"] = key;
      headers["APCA-API-SECRET-KEY"] = secret;
    } else if (url.hostname === "api.massive.com") {
      const key = this.config.massiveKey ?? process.env.POLYGON_API_KEY;
      if (!key) throw new Error("Existing Massive/Polygon credential is required");
      headers.Authorization = `Bearer ${key}`;
    } else {
      headers["User-Agent"] = url.hostname === "data.sec.gov"
        ? "Finava App liamblackshawbrown@gmail.com"
        : "FinavaTournament/0.1 (https://github.com/LBB2005/finava)";
    }
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(url.href, {
        headers,redirect:"error",signal:AbortSignal.timeout(30_000),
      });
    } catch { throw new Error(`${url.hostname} request failed; no retry`); }
    if (!response.ok) {
      if ([401,403,429].includes(response.status)) this.suspended.add(url.hostname);
      throw new Error(`${url.hostname} HTTP ${response.status}; no retry`);
    }
    const data: unknown = await response.json();
    if (file) {
      await mkdir(this.config.directory!,{recursive:true});
      const saved = {url:url.href,observedAt:new Date().toISOString(),data};
      try { await writeFile(file, JSON.stringify(saved), {flag:"wx", mode:0o600}); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const prior = JSON.parse(await readFile(file,"utf8"));
        if (prior.url !== url.href) throw new Error("Provider archive collision");
        return prior.data;
      }
    }
    return data;
  }
}
