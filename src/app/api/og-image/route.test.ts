import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/** One scripted HTTP response for a given absolute URL. */
interface Scripted {
  status?: number;
  location?: string;
  contentType?: string;
  /** Emitted as one or more `data` chunks. */
  body?: string;
  /** Emit `error` on the request instead of responding (network failure). */
  requestError?: string;
  /** Emit `timeout` on the request (the route destroys it → request error). */
  timeout?: boolean;
  /** End the response with `close` instead of `end`. */
  closeInsteadOfEnd?: boolean;
}

const deps = vi.hoisted(() => ({
  responses: new Map<string, unknown>(),
  requested: [] as { url: string; options: Record<string, unknown> }[],
  resolvePinnedIp: vi.fn(),
  pinnedLookup: vi.fn(() => "LOOKUP_FN"),
  guardDataRoute: vi.fn(),
}));

vi.mock("@/lib/ssrfGuard", () => ({
  resolvePinnedIp: deps.resolvePinnedIp,
  pinnedLookup: deps.pinnedLookup,
}));
vi.mock("@/lib/dataRouteGuard", () => ({ guardDataRoute: deps.guardDataRoute }));

/** Minimal node:http(s) `get` stand-in driving the route's response handling.
 *  The same implementation backs both modules — the route picks one by scheme. */
function makeGet() {
  return (u: URL, options: Record<string, unknown>, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { destroy: (e?: Error) => void };
    deps.requested.push({ url: u.href, options });

    const script = (deps.responses.get(u.href) ?? {}) as Scripted;
    req.destroy = (err?: Error) => {
      if (err) req.emit("error", err);
    };

    queueMicrotask(() => {
      if (script.requestError) {
        req.emit("error", new Error(script.requestError));
        return;
      }
      if (script.timeout) {
        req.emit("timeout");
        return;
      }
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        setEncoding: () => void;
        resume: () => void;
        destroy: () => void;
      };
      res.statusCode = script.status ?? 200;
      res.headers = {
        ...(script.location ? { location: script.location } : {}),
        ...(script.contentType !== undefined
          ? { "content-type": script.contentType }
          : { "content-type": "text/html; charset=utf-8" }),
      };
      let destroyed = false;
      res.setEncoding = () => {};
      res.resume = () => {};
      res.destroy = () => {
        destroyed = true;
        res.emit("close");
      };

      cb(res);
      // Handlers are attached synchronously by the route; feed the body next tick.
      queueMicrotask(() => {
        if (script.body !== undefined) {
          res.emit("data", script.body);
          if (destroyed) return;
        }
        res.emit(script.closeInsteadOfEnd ? "close" : "end");
      });
    });

    return req;
  };
}

vi.mock("node:https", () => ({ default: { get: makeGet() } }));
vi.mock("node:http", () => ({ default: { get: makeGet() } }));

const { POST } = await import("./route");

function post(body: unknown) {
  return new Request("http://test.local/api/og-image", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

/** Each test uses a unique host so the route's module-level memo can't leak across tests. */
let hostSeq = 0;
function uniqueUrl(path = "/a") {
  return `https://pub${++hostSeq}.example.com${path}`;
}

function html(head: string) {
  return `<html><head>${head}</head><body>x</body></html>`;
}

async function results(body: unknown) {
  const res = await POST(post(body));
  return (await res.json()).results as Record<string, { image: string | null; domain: string | null }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.responses.clear();
  deps.requested.length = 0;
  deps.guardDataRoute.mockResolvedValue({ userId: "u1" });
  deps.resolvePinnedIp.mockResolvedValue({ address: "93.184.216.34", family: 4 });
});

describe("POST /api/og-image", () => {
  it("resolves og:image and the publisher domain", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { body: html('<meta property="og:image" content="https://cdn.x/a.jpg">') });

    await expect(results({ urls: [url] })).resolves.toEqual({
      [url]: { image: "https://cdn.x/a.jpg", domain: new URL(url).hostname },
    });
  });

  it("sets a browser-only Cache-Control header (the route is per-user now)", async () => {
    const res = await POST(post({ urls: [] }));
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
  });

  it("returns the rate-limit response without scraping anything", async () => {
    deps.guardDataRoute.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Too many requests" }, { status: 429 }),
    });
    const res = await POST(post({ urls: [uniqueUrl()] }));
    expect(res.status).toBe(429);
    expect(deps.requested).toHaveLength(0);
  });

  it("requires a session and throttles per user, as a server-side fetch primitive", async () => {
    await POST(post({ urls: [] }));
    expect(deps.guardDataRoute).toHaveBeenCalledWith("og-image", {
      capacity: 20,
      refillPerSec: 1,
    });
  });

  it("refuses non-default ports without connecting", async () => {
    const res = await POST(post({ urls: ["https://example.com:8443/a", "http://example.com:22/"] }));
    const body = await res.json();
    expect(Object.values(body.results)).toEqual([
      { image: null, domain: null },
      { image: null, domain: null },
    ]);
    expect(deps.requested).toHaveLength(0);
  });

  it("strips a leading www. from the reported domain", async () => {
    const url = `https://www.pub${++hostSeq}.example.com/a`;
    deps.responses.set(url, { body: html('<meta property="og:image" content="https://cdn.x/a.jpg">') });
    const out = await results({ urls: [url] });
    expect(out[url].domain).toBe(`pub${hostSeq}.example.com`);
  });
});

describe("meta-tag extraction", () => {
  async function imageFor(head: string) {
    const url = uniqueUrl();
    deps.responses.set(url, { body: html(head) });
    return (await results({ urls: [url] }))[url].image;
  }

  it("prefers og:image:secure_url over the other variants", async () => {
    expect(
      await imageFor(
        '<meta property="og:image" content="https://cdn.x/plain.jpg">' +
          '<meta property="og:image:secure_url" content="https://cdn.x/secure.jpg">',
      ),
    ).toBe("https://cdn.x/secure.jpg");
  });

  it("falls back through og:image:url, og:image, then the twitter variants", async () => {
    expect(await imageFor('<meta property="og:image:url" content="https://cdn.x/u.jpg">')).toBe(
      "https://cdn.x/u.jpg",
    );
    expect(await imageFor('<meta name="twitter:image" content="https://cdn.x/t.jpg">')).toBe(
      "https://cdn.x/t.jpg",
    );
    expect(await imageFor('<meta name="twitter:image:src" content="https://cdn.x/ts.jpg">')).toBe(
      "https://cdn.x/ts.jpg",
    );
  });

  it("reads the `name=` form as well as `property=`, case-insensitively", async () => {
    expect(await imageFor('<META NAME="OG:IMAGE" CONTENT="https://cdn.x/c.jpg">')).toBe(
      "https://cdn.x/c.jpg",
    );
  });

  it("keeps the first occurrence of a duplicated tag", async () => {
    expect(
      await imageFor(
        '<meta property="og:image" content="https://cdn.x/first.jpg">' +
          '<meta property="og:image" content="https://cdn.x/second.jpg">',
      ),
    ).toBe("https://cdn.x/first.jpg");
  });

  it("resolves a relative og:image against the article URL", async () => {
    const url = uniqueUrl("/news/story");
    deps.responses.set(url, { body: html('<meta property="og:image" content="/img/a.jpg">') });
    expect((await results({ urls: [url] }))[url].image).toBe(
      `https://${new URL(url).hostname}/img/a.jpg`,
    );
  });

  it("resolves a protocol-relative og:image", async () => {
    expect(await imageFor('<meta property="og:image" content="//cdn.x/a.jpg">')).toBe(
      "https://cdn.x/a.jpg",
    );
  });

  it("trims surrounding whitespace in the content value", async () => {
    expect(await imageFor('<meta property="og:image" content="  https://cdn.x/a.jpg  ">')).toBe(
      "https://cdn.x/a.jpg",
    );
  });

  it("rejects a non-http(s) og:image (e.g. a data: URI)", async () => {
    expect(await imageFor('<meta property="og:image" content="data:image/png;base64,AAAA">')).toBeNull();
  });

  it("returns null when the page has no image meta at all", async () => {
    expect(await imageFor("<title>No image</title>")).toBeNull();
  });

  it("ignores a meta tag with an empty content attribute", async () => {
    expect(await imageFor('<meta property="og:image" content="">')).toBeNull();
  });
});

describe("redirect handling", () => {
  it("follows a redirect and reports the FINAL publisher domain, not the redirector", async () => {
    const start = "https://finnhub.io/api/news?id=1";
    const final = uniqueUrl("/story");
    deps.responses.set(start, { status: 301, location: final });
    deps.responses.set(final, { body: html('<meta property="og:image" content="https://cdn.x/a.jpg">') });

    expect((await results({ urls: [start] }))[start]).toEqual({
      image: "https://cdn.x/a.jpg",
      domain: new URL(final).hostname,
    });
  });

  it("resolves a relative Location header", async () => {
    const host = `https://pub${++hostSeq}.example.com`;
    deps.responses.set(`${host}/a`, { status: 302, location: "/b" });
    deps.responses.set(`${host}/b`, { body: html('<meta property="og:image" content="https://cdn.x/b.jpg">') });
    expect((await results({ urls: [`${host}/a`] }))[`${host}/a`].image).toBe("https://cdn.x/b.jpg");
  });

  it("re-checks SSRF on every hop", async () => {
    const host = `https://pub${++hostSeq}.example.com`;
    deps.responses.set(`${host}/a`, { status: 302, location: `${host}/b` });
    deps.responses.set(`${host}/b`, { body: html("") });
    await results({ urls: [`${host}/a`] });
    expect(deps.resolvePinnedIp).toHaveBeenCalledTimes(2);
  });

  it("gives up after the hop limit", async () => {
    const host = `https://pub${++hostSeq}.example.com`;
    // Self-redirect loop.
    deps.responses.set(`${host}/a`, { status: 302, location: `${host}/a` });
    const out = await results({ urls: [`${host}/a`] });
    expect(out[`${host}/a`]).toEqual({ image: null, domain: new URL(host).hostname });
    expect(deps.requested).toHaveLength(5);
  });

  it("bails when a redirect points somewhere unparseable", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { status: 302, location: "http://[" });
    expect((await results({ urls: [url] }))[url].image).toBeNull();
  });

  it("treats a 3xx with no Location as a normal (bodyless) response", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { status: 302, body: html("") });
    expect((await results({ urls: [url] }))[url].image).toBeNull();
  });
});

describe("SSRF and URL screening", () => {
  it("rejects a non-http(s) scheme without any DNS resolution", async () => {
    const out = await results({ urls: ["file:///etc/passwd"] });
    expect(out["file:///etc/passwd"]).toEqual({ image: null, domain: null });
    expect(deps.resolvePinnedIp).not.toHaveBeenCalled();
  });

  it("rejects localhost and .local hostnames up front", async () => {
    await results({ urls: ["http://localhost/x", "http://printer.local/x"] });
    expect(deps.resolvePinnedIp).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL", async () => {
    const out = await results({ urls: ["not a url"] });
    expect(out["not a url"]).toEqual({ image: null, domain: null });
  });

  it("does not connect when the host resolves to a private IP", async () => {
    deps.resolvePinnedIp.mockResolvedValueOnce(null);
    const url = uniqueUrl();
    const out = await results({ urls: [url] });
    expect(out[url]).toEqual({ image: null, domain: new URL(url).hostname });
    expect(deps.requested).toHaveLength(0);
  });

  it("pins the connection to the vetted IP", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { body: html("") });
    await results({ urls: [url] });
    expect(deps.pinnedLookup).toHaveBeenCalledWith({ address: "93.184.216.34", family: 4 });
    expect(deps.requested[0].options.lookup).toBe("LOOKUP_FN");
  });

  it("raises maxHeaderSize past undici's cap (Yahoo's headers overflow it)", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { body: html("") });
    await results({ urls: [url] });
    expect(deps.requested[0].options.maxHeaderSize).toBe(262_144);
    expect(deps.requested[0].options.timeout).toBe(4500);
  });
});

describe("transport failures and non-HTML responses", () => {
  it("returns a null image when the request errors", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { requestError: "ECONNREFUSED" });
    expect((await results({ urls: [url] }))[url]).toEqual({
      image: null,
      domain: new URL(url).hostname,
    });
  });

  it("returns a null image when the request times out", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { timeout: true });
    expect((await results({ urls: [url] }))[url].image).toBeNull();
  });

  it("skips a non-HTML content type without reading a body", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { contentType: "application/pdf", body: html('<meta property="og:image" content="https://cdn.x/a.jpg">') });
    expect((await results({ urls: [url] }))[url].image).toBeNull();
  });

  it("accepts application/xhtml+xml", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, {
      contentType: "application/xhtml+xml",
      body: html('<meta property="og:image" content="https://cdn.x/a.jpg">'),
    });
    expect((await results({ urls: [url] }))[url].image).toBe("https://cdn.x/a.jpg");
  });

  it("returns a null image on a 4xx/5xx", async () => {
    const a = uniqueUrl();
    const b = uniqueUrl();
    deps.responses.set(a, { status: 404, body: html("") });
    deps.responses.set(b, { status: 500, body: html("") });
    const out = await results({ urls: [a, b] });
    expect(out[a].image).toBeNull();
    expect(out[b].image).toBeNull();
  });

  it("returns a null image when the body is empty", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { body: "" });
    expect((await results({ urls: [url] }))[url].image).toBeNull();
  });

  it("still extracts from a partial head delivered before `close`", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, {
      closeInsteadOfEnd: true,
      body: '<html><head><meta property="og:image" content="https://cdn.x/a.jpg">',
    });
    expect((await results({ urls: [url] }))[url].image).toBe("https://cdn.x/a.jpg");
  });

  it("stops reading at </head> rather than draining the whole page", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, {
      body:
        html('<meta property="og:image" content="https://cdn.x/a.jpg">') +
        '<meta property="og:image" content="https://cdn.x/ignored.jpg">',
    });
    expect((await results({ urls: [url] }))[url].image).toBe("https://cdn.x/a.jpg");
  });
});

describe("request body handling", () => {
  it("returns an empty result set for a body with no urls array", async () => {
    await expect(results({})).resolves.toEqual({});
    await expect(results({ urls: "https://x.com" })).resolves.toEqual({});
  });

  it("returns an empty result set for unparseable JSON", async () => {
    await expect(results("{not json")).resolves.toEqual({});
  });

  it("drops non-string entries", async () => {
    await expect(results({ urls: [1, null, { a: 1 }] })).resolves.toEqual({});
    expect(deps.requested).toHaveLength(0);
  });

  it("caps the batch at 10 urls", async () => {
    const urls = Array.from({ length: 15 }, () => uniqueUrl());
    for (const u of urls) deps.responses.set(u, { body: html("") });
    expect(Object.keys(await results({ urls }))).toHaveLength(10);
  });
});

describe("memoisation", () => {
  it("scrapes a given URL once and serves the rest from cache", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { body: html('<meta property="og:image" content="https://cdn.x/a.jpg">') });

    await results({ urls: [url] });
    expect(deps.requested).toHaveLength(1);

    await results({ urls: [url] });
    expect(deps.requested).toHaveLength(1);
  });

  it("caches misses too, so a dead link is not re-scraped within the TTL", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { status: 404, body: html("") });
    await results({ urls: [url] });
    await results({ urls: [url] });
    expect(deps.requested).toHaveLength(1);
  });

  it("re-scrapes once the cached entry has expired", async () => {
    const url = uniqueUrl();
    deps.responses.set(url, { status: 404, body: html("") });
    await results({ urls: [url] });

    // A miss is held for 15 minutes; jump past it.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await results({ urls: [url] });
    vi.useRealTimers();

    expect(deps.requested).toHaveLength(2);
  });
});
