import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  currentUser: null as null | { getIdToken: ReturnType<typeof vi.fn> },
  authStateReady: vi.fn(),
}));

vi.mock("@/lib/firebase", () => ({
  auth: {
    get currentUser() {
      return deps.currentUser;
    },
    authStateReady: () => deps.authStateReady(),
  },
}));

import { DEV_BYPASS_TOKEN, authFetch, authFetcher, getAuthToken } from "./authFetch";

beforeEach(() => {
  vi.clearAllMocks();
  deps.currentUser = null;
  vi.stubGlobal("fetch", vi.fn());
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("authFetch", () => {
  it("returns the Firebase ID token when a user is signed in", async () => {
    deps.currentUser = { getIdToken: vi.fn().mockResolvedValue("firebase-token") };

    await expect(getAuthToken()).resolves.toBe("firebase-token");
    expect(deps.currentUser.getIdToken).toHaveBeenCalled();
  });

  it("waits for Firebase to restore the session before reading currentUser", async () => {
    // Simulate a page load: the user only appears once the initial auth state resolves.
    let release!: () => void;
    deps.authStateReady.mockReturnValue(new Promise<void>((r) => (release = r)));
    const pending = getAuthToken();
    deps.currentUser = { getIdToken: vi.fn().mockResolvedValue("restored-token") };
    release();

    await expect(pending).resolves.toBe("restored-token");
  });

  it("uses the dev bypass token only outside production when the local toggle is on", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: vi.fn().mockReturnValue("1") });

    await expect(getAuthToken()).resolves.toBe(DEV_BYPASS_TOKEN);

    vi.stubEnv("NODE_ENV", "production");
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it("adds Authorization while preserving caller headers", async () => {
    deps.currentUser = { getIdToken: vi.fn().mockResolvedValue("firebase-token") };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    const res = await authFetch("/api/private", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/private", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer firebase-token",
      },
      body: "{}",
    });
  });

  it("parses JSON responses and throws status-coded errors for failed fetches", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ plan: "Pro" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }));

    await expect(authFetcher<{ plan: string }>("/api/user")).resolves.toEqual({ plan: "Pro" });
    await expect(authFetcher("/api/user")).rejects.toThrow("503");
  });
});
