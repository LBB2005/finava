import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/email/client", () => ({ sendEmail: deps.sendEmail }));

import { GET } from "./route";

const SECRET = "cron-secret-xyz";
const fetchMock = vi.fn();

function cronRequest(secret: string | null = SECRET) {
  return new Request("http://test.local/api/cron/openrouter-balance", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Route the two OpenRouter endpoints the check reads. */
function openRouter({ credits, key }: { credits?: Response; key?: Response }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/credits")) return credits ?? json({ data: { total_credits: 100, total_usage: 20 } });
    if (url.endsWith("/key")) return key ?? json({ data: { limit_remaining: null } });
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");
  vi.stubEnv("OPENROUTER_ALERT_USD", "");
  vi.stubEnv("ADMIN_EMAILS", "admin@finava.ai, second@finava.ai");
  vi.stubEnv("OPS_ALERT_EMAIL", "");
  deps.sendEmail.mockResolvedValue({ sent: true, id: "em_1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/cron/openrouter-balance", () => {
  it("401s without the cron secret and never calls OpenRouter", async () => {
    const res = await GET(cronRequest(null));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401s with a wrong secret", async () => {
    expect((await GET(cronRequest("nope"))).status).toBe(401);
  });

  it("fails closed when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(cronRequest())).status).toBe(401);
  });

  it("does not email when the balance is above the default $10 threshold", async () => {
    openRouter({});
    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ remainingUsd: 80, thresholdUsd: 10, alerted: false });
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer or-key");
  });

  it("emails the admins when the balance is under the threshold", async () => {
    openRouter({ credits: json({ data: { total_credits: 100, total_usage: 96.5 } }) });
    const res = await GET(cronRequest());
    await expect(res.json()).resolves.toMatchObject({ remainingUsd: 3.5, alerted: true });
    expect(deps.sendEmail).toHaveBeenCalledOnce();
    const [to, content] = deps.sendEmail.mock.calls[0];
    expect(to).toEqual(["admin@finava.ai", "second@finava.ai"]);
    expect(content.subject).toContain("$3.50");
    expect(content.text).toContain("$10.00");
  });

  it("honours OPENROUTER_ALERT_USD and OPS_ALERT_EMAIL", async () => {
    vi.stubEnv("OPENROUTER_ALERT_USD", "50");
    vi.stubEnv("OPS_ALERT_EMAIL", "ops@finava.ai");
    openRouter({});
    const body = await (await GET(cronRequest())).json();
    expect(body).toMatchObject({ remainingUsd: 80, thresholdUsd: 50, alerted: false });

    openRouter({ credits: json({ data: { total_credits: 100, total_usage: 60 } }) });
    await GET(cronRequest());
    expect(deps.sendEmail.mock.calls[0][0]).toEqual(["ops@finava.ai"]);
  });

  it("uses the key's own spend limit when it is tighter than the account balance", async () => {
    openRouter({ key: json({ data: { limit_remaining: 2 } }) });
    const body = await (await GET(cronRequest())).json();
    expect(body).toMatchObject({ remainingUsd: 2, alerted: true });
  });

  it("alerts when the balance cannot be read at all (a dead key is an outage too)", async () => {
    openRouter({ credits: json({ error: "unauthorized" }, 401), key: json({ error: "unauthorized" }, 401) });
    const res = await GET(cronRequest());
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ remainingUsd: null, alerted: true });
    expect(deps.sendEmail.mock.calls[0][1].subject).toMatch(/could not read/i);
  });

  it("alerts when OPENROUTER_API_KEY is missing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const res = await GET(cronRequest());
    expect(res.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.sendEmail).toHaveBeenCalledOnce();
  });

  it("reports alerted:false when there is nobody to email", async () => {
    vi.stubEnv("ADMIN_EMAILS", "");
    openRouter({ credits: json({ data: { total_credits: 1, total_usage: 1 } }) });
    const body = await (await GET(cronRequest())).json();
    expect(body).toMatchObject({ remainingUsd: 0, alerted: false, reason: "no recipients" });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });
});
