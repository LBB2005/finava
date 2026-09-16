import type { QuickContext } from "@/lib/quickContext";

/**
 * Per-conversation memory of what the last turn already fetched.
 *
 * From the 13–14 Sep readout: 13 brevity requests ("so yes or no?", "3 bullets",
 * "simpler") each kicked off a brand-new run, refetching everything to re-cut an
 * answer we had just produced. A reformat should cost one cheap model call and
 * no data fetches at all.
 *
 * Two layers, on purpose. The in-memory map serves the common case — a follow-up
 * seconds later on a warm instance — with zero reads. Firestore carries it
 * across instances and restarts, stamped with a 24 h expiry so a conversation
 * doc doesn't accumulate data nobody will ever reuse.
 */

/** How long stored turn data is kept at all. */
export const TURN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How old data may be and still be reused instead of refetched.
 *
 * Fifteen minutes: long enough to cover a real back-and-forth, short enough that
 * a quoted price is still the price. Past this we refetch even for "simpler".
 */
export const REUSE_MAX_AGE_MS = 15 * 60 * 1000;

export interface TurnData {
  quickContext: QuickContext;
  /** ISO instant this turn's data was gathered. */
  storedAt: string;
  /**
   * The crew's gathered sub-agent outputs, keyed by agent tool name
   * (`run_dcf_agent`, …), when a full analysis produced them. Written by the
   * crew; the fast lane reads them so a short follow-up after a full analysis
   * ("so yes or no?") is answered from what the crew already gathered.
   */
  crewOutputs?: Record<string, string>;
}

// ── In-memory layer ──────────────────────────────────────────────────────────

const g = globalThis as typeof globalThis & { __finavaTurnData?: Map<string, TurnData> };

function cache(): Map<string, TurnData> {
  g.__finavaTurnData ??= new Map();
  return g.__finavaTurnData;
}

function key(userId: string, convId: string): string {
  return `${userId}:${convId}`;
}

/** Test seam — drops the in-memory layer so the Firestore path can be exercised. */
export function resetTurnDataCache(): void {
  cache().clear();
}

// ── Freshness ────────────────────────────────────────────────────────────────

/**
 * May this stored turn be reused instead of refetching?
 *
 * An unparseable timestamp is treated as NOT reusable. The alternative — a
 * default that reads as fresh — would serve a stale price as a current one,
 * which is the exact failure the as-of discipline exists to prevent.
 */
export function isReusable(data: TurnData | null | undefined, nowMs = Date.now()): boolean {
  if (!data) return false;
  const stored = Date.parse(data.storedAt);
  if (!Number.isFinite(stored)) return false;
  const age = nowMs - stored;
  return age >= 0 && age <= REUSE_MAX_AGE_MS;
}

function isExpired(storedAt: string, nowMs: number): boolean {
  const stored = Date.parse(storedAt);
  if (!Number.isFinite(stored)) return true;
  return nowMs - stored > TURN_TTL_MS;
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Firestore is imported lazily so the pure half of this module — the freshness
 * rules the chat route needs on every turn — can be imported without pulling in
 * firebase-admin (which validates service-account env at module load).
 */
async function convDoc(userId: string, convId: string) {
  const { db } = await import("@/lib/firebase-admin");
  return db.collection("users").doc(userId).collection("conversations").doc(convId);
}

/**
 * Remember this turn's data for follow-ups. Never throws: losing the cache costs
 * one refetch, and a metering-style failure must not take down the answer.
 */
export async function saveTurnData(userId: string, convId: string, data: TurnData): Promise<void> {
  cache().set(key(userId, convId), data);
  try {
    await (await convDoc(userId, convId)).set(
      {
        turnData: {
          json: JSON.stringify(data),
          storedAt: data.storedAt,
          expiresAt: new Date(Date.now() + TURN_TTL_MS).toISOString(),
        },
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("[turnData] persist failed (in-memory copy kept):", err);
  }
}

/** The last turn's data for this conversation, or null. Never throws. */
export async function loadTurnData(userId: string, convId: string): Promise<TurnData | null> {
  const hit = cache().get(key(userId, convId));
  if (hit) return isExpired(hit.storedAt, Date.now()) ? null : hit;

  try {
    const snap = await (await convDoc(userId, convId)).get();
    const raw = snap.data()?.turnData as { json?: string; storedAt?: string } | undefined;
    if (!raw?.json || !raw.storedAt) return null;
    if (isExpired(raw.storedAt, Date.now())) return null;
    const parsed = JSON.parse(raw.json) as TurnData;
    cache().set(key(userId, convId), parsed);
    return parsed;
  } catch (err) {
    console.warn("[turnData] load failed (will refetch):", err);
    return null;
  }
}

/**
 * Store what a crew run gathered, alongside whatever the fast lane already
 * fetched for this conversation.
 *
 * Merges rather than replaces: a turn can have both a QuickContext (fast lane)
 * and crew outputs, and neither should erase the other. Best-effort by design —
 * losing the scratch copy costs a refetch, never an answer.
 */
export async function recordCrewOutputs(
  userId: string | undefined,
  convId: string | undefined,
  crewOutputs: Record<string, string>
): Promise<void> {
  if (!userId || !convId || !Object.keys(crewOutputs).length) return;
  const prev = await loadTurnData(userId, convId).catch(() => null);
  await saveTurnData(userId, convId, {
    ...(prev ?? {}),
    quickContext: prev?.quickContext ?? null,
    storedAt: new Date().toISOString(),
    crewOutputs: { ...(prev?.crewOutputs ?? {}), ...crewOutputs },
  } as TurnData);
}
