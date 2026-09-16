import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  assignTesterPlan: vi.fn(),
  readTesterPlan: vi.fn(),
}));

vi.mock("@/lib/requireAdmin", () => ({ requireAdmin: deps.requireAdmin }));
vi.mock("@/lib/testerPlan", async (orig) => ({
  ...(await orig<typeof import("@/lib/testerPlan")>()),
  assignTesterPlan: deps.assignTesterPlan,
  readTesterPlan: deps.readTesterPlan,
}));
// isPlanName comes from the real module; it only needs the plan table.
vi.mock("@/lib/firebase-admin", () => ({ db: {}, adminAuth: {} }));

const post = (body: unknown) =>
  new Request("http://localhost/api/admin/tester-plan", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  deps.requireAdmin.mockReset().mockResolvedValue({ userId: "admin1" });
  deps.assignTesterPlan.mockReset().mockResolvedValue({ ok: true, uid: "t1", plan: "Analyst" });
  deps.readTesterPlan.mockReset().mockResolvedValue({ ok: true, uid: "t1", plan: null });
});

describe("POST /api/admin/tester-plan", () => {
  it("assigns a plan to a tester", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ email: "t@example.com", plan: "Analyst" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: "t1", plan: "Analyst" });
    expect(deps.assignTesterPlan).toHaveBeenCalledWith(
      { uid: undefined, email: "t@example.com" },
      "Analyst"
    );
  });

  it("treats an explicit null as the clear operation", async () => {
    deps.assignTesterPlan.mockResolvedValue({ ok: true, uid: "t1", plan: null });
    const { POST } = await import("./route");
    const res = await POST(post({ uid: "t1", plan: null }));
    expect(res.status).toBe(200);
    expect(deps.assignTesterPlan).toHaveBeenCalledWith({ uid: "t1", email: undefined }, null);
  });

  it("rejects a plan name that isn't a real tier", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ uid: "t1", plan: "Platinum" }));
    expect(res.status).toBe(400);
    expect(deps.assignTesterPlan).not.toHaveBeenCalled();
  });

  it("rejects a missing plan field rather than guessing", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ uid: "t1" }))).status).toBe(400);
  });

  it("rejects a body that isn't JSON", async () => {
    const { POST } = await import("./route");
    expect((await POST(post("not json"))).status).toBe(400);
  });

  it("passes a refusal from the allowlist check straight through", async () => {
    deps.assignTesterPlan.mockResolvedValue({ ok: false, status: 403, error: "not allowlisted" });
    const { POST } = await import("./route");
    const res = await POST(post({ uid: "stranger", plan: "Pro" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not allowlisted" });
  });

  it("is admin-only", async () => {
    deps.requireAdmin.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    const { POST } = await import("./route");
    const res = await POST(post({ uid: "t1", plan: "Pro" }));
    expect(res.status).toBe(403);
    expect(deps.assignTesterPlan).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/tester-plan", () => {
  it("reports the current assignment", async () => {
    deps.readTesterPlan.mockResolvedValue({ ok: true, uid: "t1", plan: "Pro" });
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/admin/tester-plan?email=t@example.com"));
    expect(await res.json()).toEqual({ uid: "t1", plan: "Pro" });
  });

  it("is admin-only", async () => {
    deps.requireAdmin.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/admin/tester-plan?uid=t1"));
    expect(res.status).toBe(403);
    expect(deps.readTesterPlan).not.toHaveBeenCalled();
  });
});
