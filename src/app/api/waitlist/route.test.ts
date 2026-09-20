import { beforeEach, describe, expect, it, vi } from "vitest";

// Self-contained mocks in vi.hoisted so the `@/lib/firebase-admin` factory has no
// cross-reference to a later top-level const (which would TDZ under mock hoisting).
const deps = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    sendEmail: vi.fn(),
    rateLimitGuard: vi.fn(),
    afterCb: null as null | (() => Promise<void>),
    db: {
      // Serial transactions over the same store (Firestore transactions are serializable).
      runTransaction: async <T,>(fn: (tx: {
        get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
        set: (ref: { set: (v: unknown, o?: unknown) => Promise<void> }, v: unknown, o?: unknown) => void;
      }) => Promise<T>): Promise<T> => {
        const writes: Array<() => Promise<void>> = [];
        const out = await fn({ get: (r) => r.get(), set: (r, v, o) => void writes.push(() => r.set(v, o)) });
        for (const w of writes) await w();
        return out;
      },
      collection: (col: string) => ({
        doc: (id: string) => {
          const key = `${col}/${id}`;
          return {
            get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
            set: async (v: Record<string, unknown>, o?: { merge?: boolean }) => {
              store.set(key, o?.merge ? { ...(store.get(key) ?? {}), ...v } : v);
            },
          };
        },
      }),
    },
  };
});

vi.mock("next/server", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, after: (fn: () => Promise<void>) => { deps.afterCb = fn; } };
});
vi.mock("firebase-admin", () => ({ firestore: { FieldValue: { serverTimestamp: () => "ts" } } }));
vi.mock("@/lib/firebase-admin", () => ({ db: deps.db }));
vi.mock("@/lib/email/client", () => ({ sendEmail: deps.sendEmail }));
vi.mock("@/lib/email/templates", () => ({ waitlistConfirmationEmail: () => ({ subject: "hi", html: "<p>" }) }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: deps.rateLimitGuard }));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://test.local/api/waitlist", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.store.clear();
  deps.afterCb = null;
  deps.rateLimitGuard.mockResolvedValue(null);
  deps.sendEmail.mockResolvedValue({ sent: true });
});

describe("POST /api/waitlist", () => {
  it("returns the limiter response when throttled", async () => {
    deps.rateLimitGuard.mockResolvedValueOnce(new Response("no", { status: 429 }));
    const res = await POST(req({ email: "a@b.com" }));
    expect(res.status).toBe(429);
  });

  it("400s an invalid email", async () => {
    const res = await POST(req({ email: "not-an-email" }));
    expect(res.status).toBe(400);
  });

  it("400s a non-JSON body", async () => {
    const res = await POST(req("{ broken"));
    expect(res.status).toBe(400);
  });

  it("stores a new signup (normalized) and sends a confirmation email", async () => {
    const res = await POST(req({ email: "New@Example.com " }));
    expect(res.status).toBe(200);
    expect(deps.store.get("waitlist/new@example.com")).toMatchObject({ email: "new@example.com" });
    // First signup schedules the confirmation email via after().
    expect(deps.afterCb).toBeTypeOf("function");
    await deps.afterCb!();
    expect(deps.sendEmail).toHaveBeenCalledWith("new@example.com", expect.any(Object));
  });

  it("does not re-email a duplicate signup", async () => {
    deps.store.set("waitlist/dup@example.com", { email: "dup@example.com" });
    const res = await POST(req({ email: "dup@example.com" }));
    expect(res.status).toBe(200);
    expect(deps.afterCb).toBeNull(); // no confirmation scheduled
  });
});

describe("POST /api/waitlist — email-bomb resistance", () => {
  // Regression: every exact-new string got a confirmation, so sub-address and
  // dot variants aimed unlimited Finava mail at one inbox.
  it("sends one confirmation per delivering mailbox, whatever the variant", async () => {
    for (const email of ["victim@gmail.com", "victim+1@gmail.com", "v.ictim@gmail.com", "VICTIM+2@googlemail.com"]) {
      await POST(req({ email }));
      await deps.afterCb?.();
      deps.afterCb = null;
    }
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("stops sending confirmations once the global daily cap is spent", async () => {
    deps.store.set(`waitlistStats/${new Date().toISOString().slice(0, 10)}`, { confirmations: 300 });
    const res = await POST(req({ email: "fresh@example.com" }));
    await deps.afterCb?.();
    expect(res.status).toBe(200); // the signup itself still succeeds
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.store.has("waitlist/fresh@example.com")).toBe(true);
  });
});
