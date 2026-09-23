// The fake Firestore is assembled per test file rather than shared: src/test/
// fakeFirestore.ts has no runTransaction or batch, and it is not one of this
// module's files to extend. It is wrapped rather than reimplemented.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeFirestore } from "@/test/fakeFirestore";
import type { FirestoreLike } from "./store";
import {
  BudgetExceededError,
  DEFAULT_DAILY_CREDIT_CAP,
  DEFAULT_RUN_CREDIT_CAP,
  assertBudgetAvailable,
  budgetDay,
  budgetStatus,
  chargeStage,
  readBudget,
  resolveCaps,
  resolveDailyCap,
  resolveRunCreditCap,
  scopeStatus,
} from "./runBudget";

type Data = Record<string, unknown>;

function makeDb() {
  const base = createFakeFirestore();
  const { docs } = base;
  const write = (ref: { path: string }, data: Data, o?: { merge?: boolean }) => {
    const prev = o?.merge ? (docs.get(ref.path) ?? {}) : {};
    docs.set(ref.path, structuredClone({ ...prev, ...data }));
  };
  const snapOf = (path: string) => {
    const d = docs.get(path);
    return {
      id: path.split("/").at(-1) ?? path,
      exists: d !== undefined,
      data: () => (d ? structuredClone(d) : undefined),
    };
  };
  // Transactions are SERIALIZED. Real Firestore resolves the same contention
  // optimistically — the loser re-reads and retries — and every transaction in this
  // module keeps its reads and writes together, so the two models agree.
  let chain: Promise<unknown> = Promise.resolve();
  const db = {
    collection: base.db.collection,
    batch() {
      const ops: Array<() => void> = [];
      return {
        set: (r: { path: string }, d: Data, o?: { merge?: boolean }) => ops.push(() => write(r, d, o)),
        delete: (r: { path: string }) => ops.push(() => docs.delete(r.path)),
        commit: async () => ops.forEach((op) => op()),
      };
    },
    runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const writes: Array<() => void> = [];
        const out = await fn({
          get: async (r: { path: string }) => snapOf(r.path),
          set: (r: { path: string }, d: Data, o?: { merge?: boolean }) =>
            writes.push(() => write(r, d, o)),
        });
        writes.forEach((w) => w());
        return out;
      };
      const next = chain.then(run, run);
      chain = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
  };
  return { db: db as unknown as FirestoreLike, docs };
}

const UID = "user_1";
const RUN = "run_1";
const now = () => new Date("2026-09-22T10:00:00Z");

let fake: ReturnType<typeof makeDb>;

beforeEach(() => {
  fake = makeDb();
  fake.docs.set(`users/${UID}/investmentRuns/${RUN}`, { id: RUN, ownerUid: UID, creditsSpent: 0 });
});

describe("cap resolution", () => {
  it.each([
    ["a plain number", "900", 900],
    ["an unset value", undefined, DEFAULT_RUN_CREDIT_CAP],
    ["nonsense", "abc", DEFAULT_RUN_CREDIT_CAP],
    ["zero", "0", DEFAULT_RUN_CREDIT_CAP],
    ["a negative", "-5", DEFAULT_RUN_CREDIT_CAP],
  ])("resolves the run cap from %s", (_label, raw, expected) => {
    expect(resolveRunCreditCap(raw)).toBe(expected);
  });

  it("falls back to the daily default when unset", () => {
    expect(resolveDailyCap(undefined)).toBe(DEFAULT_DAILY_CREDIT_CAP);
  });

  it("reads both ceilings from the environment", () => {
    expect(
      resolveCaps({
        INVESTMENT_RUN_CREDIT_CAP: "111",
        INVESTMENT_DAILY_CREDIT_CAP: "222",
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual({ run: 111, day: 222 });
  });
});

describe("pure status", () => {
  it("reports remaining room below a cap", () => {
    expect(scopeStatus(1000, 250)).toMatchObject({ remaining: 750, exhausted: false, warning: false });
  });

  it("warns at 80% without stopping the stage", () => {
    expect(scopeStatus(1000, 800)).toMatchObject({ exhausted: false, warning: true });
  });

  it("is exhausted exactly at the cap, not only past it", () => {
    expect(scopeStatus(1000, 1000).exhausted).toBe(true);
  });

  it("names the run scope when both ceilings are breached", () => {
    expect(budgetStatus({ run: 10, day: 10 }, { run: 10, day: 10 }).blockedBy).toBe("run");
  });

  it("names the day scope when only the day is breached", () => {
    expect(budgetStatus({ run: 100, day: 10 }, { run: 5, day: 10 }).blockedBy).toBe("day");
  });

  it("blocks nothing when both have room", () => {
    expect(budgetStatus({ run: 100, day: 100 }, { run: 5, day: 5 }).blockedBy).toBeNull();
  });
});

describe("budgetDay", () => {
  it("uses UTC, so a ceiling cannot be reset twice in one real day", () => {
    expect(budgetDay(new Date("2026-09-22T23:30:00-05:00"))).toBe("2026-09-23");
  });
});

describe("chargeStage", () => {
  const caps = { run: 100, day: 1000 };

  it("accumulates the total BETWEEN invocations", async () => {
    await chargeStage(UID, RUN, "snapshot", 30, { db: fake.db, caps, now });
    const status = await chargeStage(UID, RUN, "research", 25, { db: fake.db, caps, now });
    expect(status.run.spent).toBe(55);
    expect(fake.docs.get(`users/${UID}/investmentRuns/${RUN}`)?.creditsSpent).toBe(55);
  });

  it("records each stage's measured spend separately", async () => {
    await chargeStage(UID, RUN, "valuation", 12, { db: fake.db, caps, now });
    const stageCredits = fake.docs.get(`users/${UID}/investmentRuns/${RUN}`)?.stageCredits as Data;
    expect(stageCredits.valuation).toMatchObject({ credits: 12 });
  });

  it("charges the per-user day total as well as the run", async () => {
    await chargeStage(UID, RUN, "snapshot", 40, { db: fake.db, caps, now });
    expect(fake.docs.get(`users/${UID}/investmentBudget/2026-09-22`)?.creditsSpent).toBe(40);
  });

  it("records the spend and THEN refuses, so the total is never under-reported", async () => {
    await expect(
      chargeStage(UID, RUN, "scenarios", 120, { db: fake.db, caps, now })
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fake.docs.get(`users/${UID}/investmentRuns/${RUN}`)?.creditsSpent).toBe(120);
  });

  it("stops on the daily ceiling even when this run has room", async () => {
    fake.docs.set(`users/${UID}/investmentBudget/2026-09-22`, { creditsSpent: 995 });
    const err = await chargeStage(UID, RUN, "research", 10, {
      db: fake.db,
      caps,
      now,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).scope).toBe("day");
  });

  it("clamps a nonsense credit figure to zero rather than trusting it", async () => {
    const status = await chargeStage(UID, RUN, "snapshot", Number.NaN, { db: fake.db, caps, now });
    expect(status.run.spent).toBe(0);
    const negative = await chargeStage(UID, RUN, "research", -500, { db: fake.db, caps, now });
    expect(negative.run.spent).toBe(0);
  });

  // THE POINT OF THIS MODULE. resolveRunCap() in usageRunCost returns Infinity for
  // admin UIDs, and during the private beta every account that can sign in is an
  // admin — so the pre-existing per-run cap does not bind the only user of this
  // feature. This ceiling must, and it does because it never consults the allowlist.
  it("binds an admin UID", async () => {
    vi.stubEnv("ADMIN_UIDS", UID);
    vi.stubEnv("OWNER_UIDS", UID);
    vi.stubEnv("ADMIN_EMAILS", "liamblackshawbrown@gmail.com");
    vi.stubEnv("INVESTMENT_RUN_CREDIT_CAP", "50");
    vi.stubEnv("INVESTMENT_DAILY_CREDIT_CAP", "5000");

    const err = await chargeStage(UID, RUN, "decision", 60, { db: fake.db, now }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).cap).toBe(50);
    vi.unstubAllEnvs();
  });
});

describe("assertBudgetAvailable", () => {
  it("passes when there is room and writes nothing", async () => {
    const before = fake.docs.size;
    await expect(
      assertBudgetAvailable(UID, RUN, "snapshot", { db: fake.db, caps: { run: 100, day: 100 }, now })
    ).resolves.toMatchObject({ blockedBy: null });
    expect(fake.docs.size).toBe(before);
  });

  it("refuses an already-exhausted run BEFORE a provider is called", async () => {
    fake.docs.set(`users/${UID}/investmentRuns/${RUN}`, { creditsSpent: 100 });
    await expect(
      assertBudgetAvailable(UID, RUN, "research", { db: fake.db, caps: { run: 100, day: 1000 }, now })
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe("readBudget", () => {
  it("reports an untouched run as fully available", async () => {
    const status = await readBudget(UID, RUN, { db: fake.db, caps: { run: 100, day: 200 }, now });
    expect(status).toMatchObject({ blockedBy: null });
    expect(status.run.remaining).toBe(100);
    expect(status.day.remaining).toBe(200);
  });
});
