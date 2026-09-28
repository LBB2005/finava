// The Finava Live ledger — the ONLY module that writes a `live*` collection.
//
// Three properties this file exists to guarantee:
//
//  1. APPEND-ONLY. Every write goes through `create()`, never `set()`. Firestore
//     throws ALREADY_EXISTS on a duplicate doc id, so a replayed GitHub Actions
//     step fails loudly instead of silently overwriting yesterday's record.
//     Doc ids are deterministic precisely so that replay collides.
//
//  2. TAMPER-EVIDENT. Each entry carries `prevHash` and
//     `hash = sha256(canonicalJson(payload) + prevHash)`, chained per collection
//     with the heads in `liveConfig/chainHead`. Each trading day's public commit
//     publishes the heads, so an outsider can recompute the chain from the
//     published files and prove nothing was edited after the fact. That turns
//     "append-only" from a policy we assert into a property anyone can check.
//
//  3. NO EDITS, EVER. A correction is an append: a `liveEvents` doc of
//     kind "correction" referencing the superseded entry. Nothing is mutated.
//
// firestore.rules denies all client access, so enforcement is server-side
// discipline — see ledgerDiscipline.test.ts, which fails the build if any other
// module writes one of these collections.
//
// Timestamps here are ISO 8601 UTC strings, never Firestore Timestamps: every
// one of these docs is serialised into the public GitHub log, and a Timestamp
// would need converting at each boundary.

import { hashEntry } from "./ledgerHash";
export { canonicalJson, hashEntry } from "./ledgerHash";
import { CHAIN_GENESIS, type LedgerCollection } from "./ledgerCollections";
import { db } from "@/lib/firebase-admin";
import type { DecisionRecord } from "@/lib/schemas/live/decision";
import type { ConditionEval } from "@/lib/schemas/live/evaluation";
import type { OrderIntent, FillRecord } from "@/lib/schemas/live/order";
import type { BookSnapshot } from "@/lib/schemas/live/snapshot";

// Append-only collection names live in a dependency-free module so the
// discipline test can read them without importing firebase-admin.
// `liveRuns` and `liveConfig` are deliberately NOT ledger collections — they
// hold mutable working state and are not part of the chained record.
export {
  LEDGER_COLLECTIONS,
  CHAIN_GENESIS,
  type LedgerCollection,
} from "./ledgerCollections";

const CHAIN_HEAD_DOC = "chainHead";

/** Thrown when a doc id already exists — a replay, not a transient failure. */
export class LedgerConflictError extends Error {
  constructor(
    readonly collection: LedgerCollection,
    readonly docId: string
  ) {
    super(`${collection}/${docId} already exists — the ledger is append-only`);
    this.name = "LedgerConflictError";
  }
}

/**
 * Deterministic JSON: object keys sorted at every depth, so two runs that
 * produce the same data produce the same bytes and therefore the same hash.
 * `undefined` is dropped (Firestore rejects it anyway); arrays keep their order,
 * which is meaningful for votes and conditions.
 */
export interface LedgerEntry<T> {
  collection: LedgerCollection;
  docId: string;
  payload: T;
  prevHash: string;
  hash: string;
}

function chainHeadRef() {
  return db.collection("liveConfig").doc(CHAIN_HEAD_DOC);
}

/**
 * Append one entry, advancing its collection's chain.
 *
 * The head read and the doc create happen in one transaction, so two concurrent
 * appends cannot fork the chain — the loser retries against the new head. At
 * well under 100 docs/day the serialisation cost is irrelevant.
 */
async function append<T extends object>(
  collection: LedgerCollection,
  docId: string,
  payload: T
): Promise<LedgerEntry<T>> {
  const docRef = db.collection(collection).doc(docId);
  const headRef = chainHeadRef();

  return db.runTransaction(async (tx) => {
    const headSnap = await tx.get(headRef);
    const heads = (headSnap.data()?.heads ?? {}) as Record<string, string>;
    const prevHash = heads[collection] ?? CHAIN_GENESIS;
    const hash = hashEntry(payload, prevHash);

    // Queues the write; ALREADY_EXISTS surfaces on commit and is mapped below.
    tx.create(docRef, { ...payload, prevHash, hash });
    tx.set(
      headRef,
      { heads: { ...heads, [collection]: hash }, updatedAt: new Date().toISOString() },
      { merge: true }
    );

    return { collection, docId, payload, prevHash, hash };
  }).catch((err: unknown) => {
    // Firestore surfaces ALREADY_EXISTS as gRPC code 6.
    if (typeof err === "object" && err !== null && (err as { code?: number }).code === 6) {
      throw new LedgerConflictError(collection, docId);
    }
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Typed appenders. Doc ids are deterministic so replay collides rather than
// duplicating — that is the point, not an inconvenience.
// ---------------------------------------------------------------------------

export function decisionId(tradingDay: string, ticker: string, kind: string): string {
  return `${tradingDay}-${ticker.toUpperCase()}-${kind}`;
}

export function appendDecision(d: DecisionRecord) {
  return append("liveDecisions", d.decisionId, d);
}

export function appendOrder(o: OrderIntent) {
  return append("liveOrders", o.intentId, o);
}

export function appendFill(f: FillRecord) {
  return append("liveFills", f.fillId, f);
}

export function appendEvaluation(e: ConditionEval) {
  return append(
    "liveEvaluations",
    `${e.tradingDay}-${e.decisionId}-${e.conditionId}`,
    e
  );
}

export interface OutcomeRecord {
  decisionId: string;
  horizonDays: number;
  tradingDay: string;
  maturedOn: string;
  realisedReturnPct: number | null;
  benchmarkReturnPct: number | null;
  /** Did the stated thesis come true? null when it cannot be scored. */
  correct: boolean | null;
  statedProbability: number;
  createdAt: string;
}

export function appendOutcome(o: OutcomeRecord) {
  return append("liveOutcomes", `${o.decisionId}-${o.horizonDays}`, o);
}

export function appendSnapshot(s: BookSnapshot) {
  return append("liveSnapshots", s.tradingDay, s);
}

export type LiveEventKind =
  | "run_started"
  | "run_completed"
  | "run_aborted"
  | "rail_tripped"
  | "rail_cleared"
  | "version_bump"
  | "budget_exceeded"
  // An approved decision that could not become an order — no tradable price, or
  // nothing held to sell. Recorded rather than logged: a decision the rails
  // permitted and the book did not act on is a gap in the record unless the
  // reason is in the record too.
  | "execution_skipped"
  | "correction"
  | "admin_action";

export interface LiveEvent {
  eventId: string;
  tradingDay: string;
  kind: LiveEventKind;
  message: string;
  /** For a correction: the ledger entry this supersedes. Never edited in place. */
  supersedes?: { collection: LedgerCollection; docId: string };
  detail?: Record<string, unknown>;
  createdAt: string;
}

export function appendEvent(e: LiveEvent) {
  return append("liveEvents", e.eventId, e);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface ChainHeads {
  heads: Partial<Record<LedgerCollection, string>>;
  updatedAt: string | null;
}

/** Current chain heads — published in each day's commit. */
export async function getChainHeads(): Promise<ChainHeads> {
  const snap = await chainHeadRef().get();
  const data = snap.data();
  return {
    heads: (data?.heads ?? {}) as Partial<Record<LedgerCollection, string>>,
    updatedAt: (data?.updatedAt as string | undefined) ?? null,
  };
}

export interface ChainVerification {
  valid: boolean;
  length: number;
  /** Index of the first entry whose hash does not follow from its predecessor. */
  brokenAt: number | null;
  head: string;
}

/**
 * Recompute a chain from entries in order. Pure — an external verifier can run
 * this over the published GitHub files with no database access, which is the
 * whole reason the hashes are published.
 */
export function verifyChain(
  entries: { prevHash: string; hash: string; [k: string]: unknown }[],
  genesis: string = CHAIN_GENESIS
): ChainVerification {
  let prev = genesis;
  for (let i = 0; i < entries.length; i++) {
    const { prevHash, hash, ...payload } = entries[i];
    if (prevHash !== prev || hashEntry(payload, prevHash) !== hash) {
      return { valid: false, length: entries.length, brokenAt: i, head: prev };
    }
    prev = hash;
  }
  return { valid: true, length: entries.length, brokenAt: null, head: prev };
}
