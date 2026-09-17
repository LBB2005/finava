/**
 * Investor DNA — Firestore wrappers around the pure engine in `@/lib/investorDna`.
 *
 * Kept separate so the engine itself imports no infra (firebase-admin would
 * otherwise initialize at module load and break unit tests). The cached snapshot
 * lives at `users/{uid}/investorDNA/current`.
 */

import { db } from "@/lib/firebase-admin";
import { getFactorUniverse } from "@/lib/factorUniverse";
import { getCandles } from "@/lib/finnhub";
import { buildDnaSummary, computeInvestorDna, DNA_VERSION, type DnaHolding } from "@/lib/investorDna";
import { resolvePositionHistory } from "@/lib/investorDnaHistory";
import { ETF_PROFILES } from "@/lib/extraUniverse";
import type { InvestorDNA } from "@/types/dna";

function dnaDoc(userId: string) {
  return db.collection("users").doc(userId).collection("investorDNA").doc("current");
}

/** Recompute fresh from holdings + the scored universe, write the snapshot, return it. */
export async function deriveAndCacheDna(userId: string): Promise<InvestorDNA | null> {
  // Short-circuit before the expensive factor-universe compute: a user with no
  // holdings has no DNA to derive, so new users hit the empty state instantly
  // instead of waiting on a full S&P scoring pass they don't need.
  const holdingsSnap = await db.collection("users").doc(userId).collection("holdings").get();
  if (holdingsSnap.empty) return null;

  const holdings = holdingsSnap.docs.map((d) => d.data() as DnaHolding);
  const universe = await getFactorUniverse();
  const history = await resolvePositionHistory(holdings, universe.stocks, {
    dailyCloses: async (ticker, from, to) => {
      const r = await getCandles(ticker, "D", from, to);
      return r.s === "ok" ? { t: r.t, c: r.c } : { t: [], c: [] };
    },
  });
  const dna = computeInvestorDna(holdings, universe.stocks, ETF_PROFILES, { history });
  if (dna) {
    await dnaDoc(userId).set(dna).catch((e) => console.error("[investorDna] cache write", e));
  }
  return dna;
}

/**
 * Read the cached snapshot (fast path for the Lens); null if never derived, or
 * if it predates the current shape (older snapshots claimed unbenchmarked edges).
 */
export async function readCachedDna(userId: string): Promise<InvestorDNA | null> {
  try {
    const snap = await dnaDoc(userId).get();
    if (!snap.exists) return null;
    const dna = snap.data() as InvestorDNA;
    return dna.version === DNA_VERSION ? dna : null;
  } catch {
    return null;
  }
}

/**
 * The compact inferred-profile block for chat and the crew. Cache-only: the
 * chat path never pays for a factor-universe compute. Null when DNA is turned
 * off, never derived, or anything fails.
 */
export async function loadDnaSummary(userId: string): Promise<string | null> {
  try {
    const settings = await db.collection("userSettings").doc(userId).get();
    if (settings.data()?.allowInvestorDNA === false) return null;
    const dna = await readCachedDna(userId);
    return dna ? buildDnaSummary(dna) : null;
  } catch {
    return null;
  }
}
