import { it, expect } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderArchive } from "./providerArchive";

it("persists one immutable response and reuses it across process instances without persisting secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tournament-provider-"));
  try {
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls++;
      expect(new Headers(init?.headers).get("APCA-API-KEY-ID")).toBe("dummy-key");
      return Response.json({ close: 123 });
    };
    const config = { directory, fetch: fetcher, intervalMs: 0, key: "dummy-key", secret: "dummy-secret" };
    const first = new ProviderArchive(config);
    const url = "https://data.alpaca.markets/v2/stocks/AAPL/bars";
    expect(await first.get(url)).toEqual({close:123});
    expect(await first.get(url)).toEqual({close:123});
    expect(await new ProviderArchive(config).get(url)).toEqual({close:123});
    expect(calls).toBe(1);
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const saved = await readFile(join(directory,files[0]),"utf8");
    expect(saved).not.toContain("dummy-key");
    expect(saved).not.toContain("dummy-secret");
    expect(JSON.parse(saved).url).toBe(url);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

it("stops that provider after a rate limit and rejects off-provider or credential URLs", async () => {
  let calls = 0;
  const provider = new ProviderArchive({key:"test",secret:"test", intervalMs:0, fetch:async()=>{calls++;return new Response("private error body",{status:429});}});
  await expect(provider.get("https://data.alpaca.markets/v2/one")).rejects.toThrow("429");
  await expect(provider.get("https://data.alpaca.markets/v2/two")).rejects.toThrow("suspended");
  expect(calls).toBe(1);
  await expect(provider.get("https://evil.example/data")).rejects.toThrow();
  await expect(provider.get("https://secret@data.alpaca.markets/v2/three")).rejects.toThrow();
  await expect(provider.get("https://data.alpaca.markets/v2/three?apiKey=secret")).rejects.toThrow();
});

it("does not send market credentials to SEC and does not cache HTTP failures as data", async () => {
  const provider = new ProviderArchive({key:"test",secret:"test", intervalMs:0,fetch:async(_url,init)=>{
    expect(new Headers(init?.headers).get("APCA-API-KEY-ID")).toBeNull();
    expect(new Headers(init?.headers).get("User-Agent")).toContain("Finava");
    return new Response("secret server details",{status:500});
  }});
  await expect(provider.get("https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json")).rejects.toThrow("500");
});

it('authenticates Massive using a header and never sends that key to other providers',async()=>{
 const provider=new ProviderArchive({massiveKey:'dummy-massive',intervalMs:0,fetch:async(url,init)=>{
  expect(String(url)).not.toContain('dummy-massive');
  expect(new Headers(init?.headers).get('Authorization')).toBe(String(url).includes('api.massive.com')?'Bearer dummy-massive':null);
  return Response.json({status:'OK'});
 }});
 await provider.get('https://api.massive.com/v3/reference/tickers/BRK.B?date=2026-09-28');
 await provider.get('https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json');
});
