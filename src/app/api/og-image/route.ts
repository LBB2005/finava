// Resolve real article images for the stock News tab.
//
// Finnhub's company-news `url` is a finnhub.io redirect, and its `image` is
// frequently a generic publication logo (every Yahoo item shares one PNG). To
// show an *accurate* per-article thumbnail we follow the redirect to the real
// article and read its OpenGraph image, returning the resolved publisher domain
// too (so the source favicon is correct rather than finnhub.io's).
//
// Implemented on node:http(s) rather than fetch because some publishers (Yahoo
// Finance) send response headers larger than undici's 16 KB cap, which makes the
// global fetch throw UND_ERR_HEADERS_OVERFLOW. The low-level client lets us raise
// maxHeaderSize. Redirects are followed manually so every hop is screened against
// an SSRF allowlist, and results are memoised so the scrape happens once per URL.
import { NextRequest, NextResponse } from "next/server";
import http from "node:http";
import https from "node:https";
import { resolvePinnedIp, pinnedLookup, type PinnedIp } from "@/lib/ssrfGuard";
import { guardDataRoute } from "@/lib/dataRouteGuard";

export const runtime = "nodejs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_URLS = 10;
const MAX_HOPS = 5;
const PER_FETCH_TIMEOUT = 4500;
// The per-socket timeout above is an IDLE timeout: a host that drips a byte every
// few seconds never trips it. This caps one URL's whole redirect chain.
const PER_URL_DEADLINE_MS = 10_000;
const HEAD_BYTE_CAP = 260_000;
const MAX_HEADER_SIZE = 262_144; // 256 KB — Yahoo's headers overflow the 16 KB default
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // hold a resolved image for a day
const MISS_TTL_MS = 15 * 60 * 1000; // a miss may be transient (rate limit) — retry sooner
const MAX_CACHE_ENTRIES = 1000;

interface OgResult {
  image: string | null;
  domain: string | null;
}

// Module-level memo so repeated views don't re-scrape the same articles.
const cache = new Map<string, { result: OgResult; expires: number }>();

// Reject non-http(s) schemes and obviously-internal hostnames up front. This is
// only the first gate — the authoritative SSRF check is resolvePinnedIp() (from
// @/lib/ssrfGuard), which resolves DNS, validates the *resolved* IP, and pins the
// connection to it (defeating a public name that points at — or rebinds to — a
// private/loopback/metadata address).
function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // Default ports only: an article page never needs another, and an explicit
  // port turns this into a port scanner for whatever public hosts it can reach.
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return null;
  return u;
}

function hostLabel(u: URL): string {
  return u.hostname.replace(/^www\./, "");
}

function extractOg(html: string, base: URL): string | null {
  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta[^>]+>/gi) ?? []) {
    const key = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1];
    if (key && content && !(key in meta)) meta[key] = content;
  }
  const raw =
    meta["og:image:secure_url"] ||
    meta["og:image:url"] ||
    meta["og:image"] ||
    meta["twitter:image"] ||
    meta["twitter:image:src"] ||
    null;
  if (!raw) return null;
  try {
    const abs = new URL(raw.trim(), base).href; // resolve protocol-relative / relative paths
    return /^https?:\/\//i.test(abs) ? abs : null;
  } catch {
    return null;
  }
}

// One GET. Redirects return their Location without a body; HTML pages return the
// <head> region only (capped). Never rejects on a slow/broken body — resolves
// with whatever was read so a partial head can still yield og:image.
function getOnce(u: URL, pin: PinnedIp): Promise<{ status: number; location: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    let settled = false;
    const done = (v: { status: number; location: string | null; body: string }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = lib.get(
      u,
      {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        maxHeaderSize: MAX_HEADER_SIZE,
        timeout: PER_FETCH_TIMEOUT,
        // Pin the connection to the already-validated IP (see pinnedLookup).
        lookup: pinnedLookup(pin),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          done({ status, location, body: "" });
          return;
        }
        const ct = String(res.headers["content-type"] ?? "");
        if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
          res.resume();
          done({ status, location: null, body: "" });
          return;
        }
        let body = "";
        let received = 0;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          received += Buffer.byteLength(chunk);
          body += chunk;
          if (received >= HEAD_BYTE_CAP || body.includes("</head>")) res.destroy();
        });
        res.on("end", () => done({ status, location: null, body }));
        res.on("close", () => done({ status, location: null, body }));
        res.on("error", () => done({ status, location: null, body }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function resolveUncached(startUrl: string): Promise<OgResult> {
  let current = startUrl;
  let lastDomain: string | null = null;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const u = safeUrl(current);
    if (!u) return { image: null, domain: lastDomain };
    lastDomain = hostLabel(u);
    // Authoritative SSRF gate: resolve and reject if the host maps to any
    // private/loopback/metadata IP, then PIN the connection to the vetted IP.
    // Re-checked (and re-pinned) on every redirect hop.
    const pin = await resolvePinnedIp(u.hostname);
    if (!pin) return { image: null, domain: lastDomain };
    let r: { status: number; location: string | null; body: string };
    try {
      r = await getOnce(u, pin);
    } catch {
      return { image: null, domain: lastDomain };
    }
    if (r.status >= 300 && r.status < 400 && r.location) {
      try {
        current = new URL(r.location, u).href;
      } catch {
        return { image: null, domain: lastDomain };
      }
      continue;
    }
    if (r.status < 200 || r.status >= 300 || !r.body) return { image: null, domain: lastDomain };
    return { image: extractOg(r.body, u), domain: lastDomain };
  }
  return { image: null, domain: lastDomain };
}

async function resolve(startUrl: string): Promise<OgResult> {
  const hit = cache.get(startUrl);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.result;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<OgResult>((r) => {
    timer = setTimeout(() => r({ image: null, domain: null }), PER_URL_DEADLINE_MS);
  });
  const result = await Promise.race([resolveUncached(startUrl), deadline]).finally(() => clearTimeout(timer));
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!); // evict oldest
  cache.set(startUrl, { result, expires: now + (result.image ? CACHE_TTL_MS : MISS_TTL_MS) });
  return result;
}

export async function POST(req: NextRequest) {
  // Server-side fetch primitive: signed-in callers only (the stock News tab is the
  // one caller), throttled per user so it can't be used as a high-volume
  // scanning/SSRF probe even within the resolved-IP allowlist.
  const gate = await guardDataRoute("og-image", { capacity: 20, refillPerSec: 1 });
  if (gate.error) return gate.error;

  const body = await req.json().catch(() => null);
  const urls: string[] = Array.isArray(body?.urls)
    ? body.urls.filter((u: unknown): u is string => typeof u === "string").slice(0, MAX_URLS)
    : [];

  const entries = await Promise.all(urls.map(async (url) => [url, await resolve(url)] as const));

  return NextResponse.json(
    { results: Object.fromEntries(entries) },
    { headers: { "Cache-Control": "private, max-age=3600" } }
  );
}
