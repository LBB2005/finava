import { describe, it, expect, vi, beforeEach } from "vitest";

const deps = { get: vi.fn() };
vi.mock("@/lib/firebase-admin", () => ({
  db: { collection: () => ({ doc: () => ({ get: deps.get }) }) },
}));

import { getExperienceLevel } from "./experienceLevel.server";

// Braces matter: returning the mock from the hook makes vitest surface the
// mock's own recorded rejection as a test failure.
beforeEach(() => { deps.get.mockReset(); });

describe("getExperienceLevel", () => {
  it("reads the stored level", async () => {
    deps.get.mockResolvedValue({ exists: true, data: () => ({ experienceLevel: "beginner" }) });
    expect(await getExperienceLevel("u1")).toBe("beginner");
  });

  it("defaults when the user has never answered", async () => {
    deps.get.mockResolvedValue({ exists: true, data: () => ({}) });
    expect(await getExperienceLevel("u1")).toBe("intermediate");
  });

  it("defaults when there is no doc", async () => {
    deps.get.mockResolvedValue({ exists: false, data: () => undefined });
    expect(await getExperienceLevel("u1")).toBe("intermediate");
  });

  it("defaults for an anonymous caller without touching Firestore", async () => {
    expect(await getExperienceLevel(undefined)).toBe("intermediate");
    expect(deps.get).not.toHaveBeenCalled();
  });

  it("never throws when the read fails", async () => {
    deps.get.mockImplementation(() => Promise.reject(new Error("offline")));
    expect(await getExperienceLevel("u1")).toBe("intermediate");
  });
});
