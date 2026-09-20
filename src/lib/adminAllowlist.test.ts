import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ getUserByEmail: vi.fn() }));

vi.mock("@/lib/firebase-admin", () => ({
  adminAuth: { getUserByEmail: deps.getUserByEmail },
}));

import {
  __resetAdminAllowlistCache,
  adminEmails,
  adminUids,
  isAdminEmail,
  isAdminUid,
  isOwnerUid,
  ownerUids,
} from "./adminAllowlist";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  __resetAdminAllowlistCache();
});

afterEach(() => vi.unstubAllEnvs());

describe("env list parsing", () => {
  it("trims entries and lowercases emails", () => {
    vi.stubEnv("ADMIN_UIDS", " uid_a , uid_b ,, ");
    vi.stubEnv("ADMIN_EMAILS", " Tester@Example.com , second@example.com ");

    expect([...adminUids()]).toEqual(["uid_a", "uid_b"]);
    expect([...adminEmails()]).toEqual(["tester@example.com", "second@example.com"]);
  });
});

describe("ownerUids / isOwnerUid", () => {
  it("trims entries and matches exactly", () => {
    vi.stubEnv("OWNER_UIDS", " owner_a , owner_b ,, ");
    expect([...ownerUids()]).toEqual(["owner_a", "owner_b"]);
    expect(isOwnerUid("owner_b")).toBe(true);
    expect(isOwnerUid("OWNER_B")).toBe(false);
  });

  it("is empty (nobody is an operator) when unset", () => {
    vi.stubEnv("OWNER_UIDS", "");
    expect(ownerUids().size).toBe(0);
    expect(isOwnerUid("anyone")).toBe(false);
  });

  it("is independent of the tester allowlist", () => {
    vi.stubEnv("ADMIN_UIDS", "tester_uid");
    vi.stubEnv("ADMIN_EMAILS", "tester@example.com");
    vi.stubEnv("OWNER_UIDS", "owner_uid");
    expect(isOwnerUid("tester_uid")).toBe(false);
    expect(isOwnerUid("owner_uid")).toBe(true);
  });
});

describe("isAdminEmail", () => {
  beforeEach(() => vi.stubEnv("ADMIN_EMAILS", "tester@example.com"));

  it("matches case-insensitively when the email is verified", () => {
    expect(isAdminEmail("TESTER@example.com", true)).toBe(true);
  });

  it("rejects an unverified email even when allowlisted", () => {
    expect(isAdminEmail("tester@example.com", false)).toBe(false);
  });

  it("rejects a missing email and a non-allowlisted one", () => {
    expect(isAdminEmail(undefined, true)).toBe(false);
    expect(isAdminEmail("someone@else.com", true)).toBe(false);
  });
});

describe("isAdminUid", () => {
  it("matches ADMIN_UIDS without any Admin SDK lookup", async () => {
    vi.stubEnv("ADMIN_UIDS", "uid_a");
    await expect(isAdminUid("uid_a")).resolves.toBe(true);
    expect(deps.getUserByEmail).not.toHaveBeenCalled();
  });

  it("resolves an allowlisted email to its UID", async () => {
    vi.stubEnv("ADMIN_EMAILS", "tester@example.com");
    deps.getUserByEmail.mockResolvedValue({ uid: "uid_tester", emailVerified: true });

    await expect(isAdminUid("uid_tester")).resolves.toBe(true);
    await expect(isAdminUid("uid_other")).resolves.toBe(false);
  });

  it("does not grant access via an unverified account holding the address", async () => {
    vi.stubEnv("ADMIN_EMAILS", "tester@example.com");
    deps.getUserByEmail.mockResolvedValue({ uid: "uid_squatter", emailVerified: false });

    await expect(isAdminUid("uid_squatter")).resolves.toBe(false);
  });

  it("tolerates an allowlisted email that has never signed in", async () => {
    vi.stubEnv("ADMIN_EMAILS", "future@example.com");
    deps.getUserByEmail.mockRejectedValue({ code: "auth/user-not-found" });

    await expect(isAdminUid("anyone")).resolves.toBe(false);
  });

  it("caches the email lookup across calls", async () => {
    vi.stubEnv("ADMIN_EMAILS", "tester@example.com");
    deps.getUserByEmail.mockResolvedValue({ uid: "uid_tester", emailVerified: true });

    await isAdminUid("uid_tester");
    await isAdminUid("uid_tester");

    expect(deps.getUserByEmail).toHaveBeenCalledTimes(1);
  });

  it("re-resolves when ADMIN_EMAILS changes", async () => {
    vi.stubEnv("ADMIN_EMAILS", "one@example.com");
    deps.getUserByEmail.mockResolvedValue({ uid: "uid_one", emailVerified: true });
    await expect(isAdminUid("uid_one")).resolves.toBe(true);

    vi.stubEnv("ADMIN_EMAILS", "two@example.com");
    deps.getUserByEmail.mockResolvedValue({ uid: "uid_two", emailVerified: true });
    await expect(isAdminUid("uid_one")).resolves.toBe(false);
    await expect(isAdminUid("uid_two")).resolves.toBe(true);
  });

  it("skips the lookup entirely when no emails are allowlisted", async () => {
    vi.stubEnv("ADMIN_UIDS", "uid_a");
    await expect(isAdminUid("nobody")).resolves.toBe(false);
    expect(deps.getUserByEmail).not.toHaveBeenCalled();
  });
});
