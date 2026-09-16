/**
 * Agent Memory System
 *
 * Three capabilities:
 * 1. Result cache — each agent's output is cached in SQLite with agent-specific TTLs.
 *    Repeat queries return instantly without hitting any external APIs.
 * 2. Ticker memory — after each CEO response, Claude Haiku distills 3-5 key insights
 *    per ticker and stores them. Future runs inject these as "Previous Analysis Memory"
 *    into the CEO system prompt.
 * 3. Ticker extraction — parses free text to find mentioned stock tickers.
 */

import { createHash } from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/firebase-admin";
import { currentAsOf } from "@/lib/asOfScope";

const { Timestamp } = admin.firestore;

// ── TTL configuration (milliseconds) ─────────────────────────────────────────

const AGENT_TTL_MS: Record<string, number> = {
  run_technical_agent:    2  * 60 * 60 * 1000,
  run_options_agent:      2  * 60 * 60 * 1000,
  run_news_agent:         4  * 60 * 60 * 1000,
  run_macro_agent:        4  * 60 * 60 * 1000,
  run_sentiment_agent:    5  * 60 * 60 * 1000,
  run_hype_agent:         5  * 60 * 60 * 1000,
  // Stock-page X Chatter gauge — one Grok x_search per ticker per window,
  // shared by every viewer (market-wide data, deliberately not per-user).
  run_insider_agent:      6  * 60 * 60 * 1000,
  run_risk_agent:         12 * 60 * 60 * 1000,
  run_earnings_agent:     12 * 60 * 60 * 1000,
  run_analyst_agent:      24 * 60 * 60 * 1000,
  run_dcf_agent:          48 * 60 * 60 * 1000,
  run_fundamentals_agent: 48 * 60 * 60 * 1000,
  run_comparables_agent:  48 * 60 * 60 * 1000,
  run_graham_agent:       48 * 60 * 60 * 1000,
  run_competitor_agent:   48 * 60 * 60 * 1000,
  // Supply-chain relationships shift on a multi-quarter cadence (annual 10-Ks),
  // and the extraction is the costliest call in the Money Map — cache 14 days.
  run_supply_chain_agent: 14 * 24 * 60 * 60 * 1000,
};

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h fallback

const MAX_INSIGHTS_PER_TICKER = 15;

// Firestore `in` filters accept at most 30 comparison values per query.
const TICKER_IN_LIMIT = 30;

/** Coerce a Firestore Timestamp | ISO string | Date into a Date. */
function toDate(value: unknown): Date {
  if (value == null) return new Date(0);
  if (typeof value === "string") return new Date(value);
  if (value instanceof Date) return value;
  const ts = value as { toDate?: () => Date };
  return typeof ts.toDate === "function" ? ts.toDate() : new Date(0);
}

// ── Cache key construction ────────────────────────────────────────────────────

/**
 * Normalize input so cache keys are stable regardless of object property order
 * or array element order (e.g. ["AAPL","MSFT"] === ["MSFT","AAPL"]).
 */
function normalizeInput(input: unknown): unknown {
  if (Array.isArray(input)) {
    return [...input].sort().map(normalizeInput);
  }
  if (input !== null && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      result[key] = normalizeInput(obj[key]);
    }
    return result;
  }
  return input;
}

/**
 * Optional cache namespace for the current async context.
 *
 * The cache is keyed on (agent, input), which is right for the common case and
 * WRONG whenever a caller needs a genuinely cold run. The motivating case is
 * Finava Live's blind re-underwrite: it re-analyses a held name with the prior
 * thesis withheld, to measure whether the crew reaches the same conclusion
 * twice. But the sub-agent inputs are identical to the original underwrite's, so
 * without a namespace every sub-agent returns the FIRST run's output and the
 * "cold rerun consistency" metric is really measuring a warm cache — a number
 * that looks like a result, reads like a result, and means nothing.
 *
 * A namespace rather than a bypass flag, for two reasons: the scoped run still
 * gets caching WITHIN itself (a wave re-requesting the same agent is cheap), and
 * its results never overwrite the shared entries other users read.
 *
 * AsyncLocalStorage rather than a parameter because the crew is deep — the CEO
 * dispatches sub-agents that dispatch further, and threading a flag through
 * every signature would guarantee one path silently missed it. That path is
 * exactly where the contamination would hide.
 */
const cacheScopeStore = new AsyncLocalStorage<string>();

/** Run `fn` with every agentCache read/write namespaced under `scope`. */
export function withCacheScope<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  return cacheScopeStore.run(scope, fn);
}

/** The active namespace, or null outside a scoped run. Exported for tests. */
export function currentCacheScope(): string | null {
  return cacheScopeStore.getStore() ?? null;
}

function buildCacheKey(agentName: string, input: unknown): string {
  const normalized = normalizeInput(input);
  const canonical = JSON.stringify(normalized);
  const scope = currentCacheScope();
  const hash = createHash("sha256")
    .update(agentName + ":" + canonical + (scope ? `:@${scope}` : ""))
    .digest("hex")
    .slice(0, 16);
  return scope ? `${agentName}:${scope}:${hash}` : `${agentName}:${hash}`;
}

// ── Cache read/write ──────────────────────────────────────────────────────────

/**
 * Returns the cached result string if it exists and hasn't expired.
 *
 * Expired rows are treated as a miss and left in place — Firestore's native TTL
 * policy on the `expiresAt` field reclaims them server-side (see saveCache and
 * docs/firestore-setup.md). We no longer issue per-read delete writes.
 */
export async function checkCache(
  agentName: string,
  input: unknown
): Promise<string | null> {
  try {
    const key = buildCacheKey(agentName, input);
    const snap = await db.collection("agentCache").doc(key).get();
    if (!snap.exists) return null;
    const row = snap.data()!;
    const expiresAt = toDate(row.expiresAt);
    if (expiresAt.getTime() <= Date.now()) return null;
    console.log(`[cache HIT] ${agentName} (expires ${expiresAt.toISOString()})`);
    return row.result as string;
  } catch (err) {
    console.error("[agentMemory] checkCache error:", err);
    return null;
  }
}

// Failure shapes the sub-agents return instead of throwing. Each was observed
// being cached and then served to every user for the full TTL. Kept specific:
// the word "Unavailable" alone is legitimate (DATA_ACCURACY_RULE asks agents to
// print it for a missing metric), so it must not block a good result.
const FAILURE_MARKERS: RegExp[] = [
  /^\s*Error:/, // wave runner / CEO is_error text
  /\bDATA UNAVAILABLE\b/, // news-agent: no Finnhub articles AND no web research
  /\bError fetching\b/i, // hype-agent
  /\bAPI key not configured\b/i, // hype / sentiment without a key
  /\bsearch unavailable:/i, // sentiment-agent Perplexity failure
  /\bUnable to retrieve\b/i, // fundamentals-agent EDGAR failure
  /\bInsufficient credits\b/i, // raw OpenRouter billing error
  /\brequest failed \(status \d{3}\)/i, // raw llm.ts error text
];

/**
 * Whether an agent result is a real, successful output worth sharing across
 * users for hours. Empty output and known failure shapes are not.
 */
export function isCacheableResult(result: string): boolean {
  if (!result || !result.trim()) return false;
  return !FAILURE_MARKERS.some((re) => re.test(result));
}

/**
 * Saves an agent result to the cache with the appropriate TTL.
 *
 * Refuses to write a failure (see isCacheableResult): a swallowed provider error
 * cached here would be served to every user until the TTL expired.
 * Uses upsert so re-runs within TTL refresh the entry.
 *
 * `expiresAt` is stored as a Firestore Timestamp so the native TTL policy can
 * garbage-collect expired rows without any application-side deletes.
 */
export async function saveCache(
  agentName: string,
  input: unknown,
  result: string
): Promise<void> {
  if (!isCacheableResult(result)) {
    console.warn(`[agentMemory] not caching ${agentName}: empty or failed result`);
    return;
  }
  try {
    const key = buildCacheKey(agentName, input);
    const ttl = AGENT_TTL_MS[agentName] ?? DEFAULT_TTL_MS;
    const now = new Date();
    await db.collection("agentCache").doc(key).set({
      cacheKey: key,
      agentName,
      result,
      expiresAt: Timestamp.fromDate(new Date(now.getTime() + ttl)),
      createdAt: Timestamp.fromDate(now),
    });
  } catch (err) {
    console.error("[agentMemory] saveCache error:", err);
  }
}

// ── Ticker extraction ─────────────────────────────────────────────────────────

// Lives in `@/lib/tickers` (no firebase-admin import) so client code and the
// Auto-mode router can use it too. Re-exported here for existing call sites.
export { extractTickers } from "@/lib/tickers";

// ── Ticker memory (learning) ──────────────────────────────────────────────────

/**
 * Fetches the most recent insights for each ticker and formats them as a
 * "Previous Analysis Memory" block for injection into the CEO system prompt.
 *
 * Scoped to `userId`: a user only ever sees insights distilled from their OWN
 * analyses. Ticker memory is portfolio-aware, so a shared/global store would
 * leak one user's holdings-derived insights into another's prompt and open a
 * persistent cross-user prompt-injection path.
 */
/**
 * A row's creation instant in ms, or Infinity when it cannot be established.
 *
 * Deliberately NOT `toDate`, which defaults anything unrecognised to epoch 0.
 * That default is fine for rendering a date and exactly backwards for a cutoff:
 * an unreadable timestamp would become maximally OLD and pass every filter. Here
 * an undatable row is treated as future and withheld — recall losing a row beats
 * a decision citing one it could not have known.
 */
function rowCreatedMs(row: Record<string, unknown>): number {
  const raw = row.createdAt;
  let ms = Number.NaN;
  if (typeof raw === "string") {
    ms = Date.parse(raw);
  } else if (raw instanceof Date) {
    ms = raw.getTime();
  } else if (typeof (raw as { toDate?: () => Date })?.toDate === "function") {
    try {
      ms = (raw as { toDate: () => Date }).toDate().getTime();
    } catch {
      ms = Number.NaN;
    }
  }
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export async function getTickerMemory(userId: string, tickers: string[]): Promise<string> {
  if (!userId || !tickers.length) return "";
  try {
    const upper = [...new Set(tickers.map((t) => t.toUpperCase()))];

    // Batch the reads: one `in` query per 30-ticker chunk instead of one query
    // per ticker. Each ticker holds at most MAX_INSIGHTS_PER_TICKER rows, so a
    // limit of chunk.length * cap can never truncate a ticker's history.
    const chunks: string[][] = [];
    for (let i = 0; i < upper.length; i += TICKER_IN_LIMIT) {
      chunks.push(upper.slice(i, i + TICKER_IN_LIMIT));
    }
    const snaps = await Promise.all(
      chunks.map((chunk) =>
        db.collection("tickerMemory")
          .where("userId", "==", userId)
          .where("ticker", "in", chunk)
          .orderBy("createdAt", "desc")
          .limit(chunk.length * MAX_INSIGHTS_PER_TICKER)
          .get()
      )
    );

    // Group newest-first per ticker, capping each at MAX_INSIGHTS_PER_TICKER.
    //
    // The as-of cutoff is applied HERE rather than as a Firestore inequality:
    // combining `ticker in [...]` with a range on createdAt needs its own
    // composite index, and this collection is already one index short. Filtering
    // in memory can under-fill a ticker whose newest rows all post-date the
    // cutoff, which is the safe direction to fail — recall returns less than it
    // could, never more than it should.
    const cutoff = currentAsOf();
    const cutoffMs = cutoff ? Date.parse(cutoff) : NaN;
    const byTicker = new Map<string, Record<string, unknown>[]>();
    for (const snap of snaps) {
      for (const doc of snap.docs) {
        const row = doc.data();
        if (!Number.isNaN(cutoffMs) && rowCreatedMs(row) > cutoffMs) continue;
        const key = String(row.ticker);
        const arr = byTicker.get(key) ?? [];
        if (arr.length < MAX_INSIGHTS_PER_TICKER) {
          arr.push(row);
          byTicker.set(key, arr);
        }
      }
    }

    // Emit in the caller's ticker order to keep the injected block stable.
    const lines: string[] = [];
    for (const ticker of upper) {
      for (const r of byTicker.get(ticker) ?? []) {
        const createdAt =
          typeof r.createdAt === "string"
            ? r.createdAt
            : toDate(r.createdAt).toISOString();
        const date = createdAt.slice(0, 10);
        const src = r.source ? ` · ${r.source}` : "";
        lines.push(`[${r.ticker} · ${date}${src}] ${r.insight}`);
      }
    }
    if (!lines.length) return "";

    return `## Previous Analysis Memory\nThe following insights were distilled from earlier analyses. Use them to identify what has changed and add longitudinal perspective:\n${lines.join("\n")}`;
  } catch (err) {
    console.error("[agentMemory] getTickerMemory error:", err);
    return "";
  }
}

/**
 * Uses Claude Haiku to extract 3-5 key insights from a completed CEO response,
 * then stores them per ticker. Caps at MAX_INSIGHTS_PER_TICKER per ticker.
 *
 * IMPORTANT: This should be called fire-and-forget (no await at call site).
 * It runs after the response stream has closed, so it adds zero user-visible latency.
 *
 * Rows are stamped with `userId` and every read/prune is scoped to it, so a
 * user's insights never bleed into another user's memory (see getTickerMemory).
 */
export async function saveTickerMemory(
  userId: string,
  tickers: string[],
  finalResponse: string,
  anthropicClient: Anthropic
): Promise<void> {
  if (!userId || !tickers.length || !finalResponse) return;

  try {
    const response = await anthropicClient.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Extract 3-5 concise investment insights from this analysis report.

Rules:
- Each insight must be 1-2 sentences maximum
- Each insight must start with the ticker it applies to in the format: TICKER: insight text
- Only use tickers from this list: ${tickers.join(", ")}
- Focus on: valuation levels, key risks, technical signals, catalyst timelines, sentiment shifts, or fundamental trends that would be useful in future analysis
- Be specific with numbers when present (e.g. "NVDA DCF fair value ~$850 at 10% WACC")
- Do NOT include general market commentary — only ticker-specific insights

Analysis to extract from:
${finalResponse.slice(0, 3500)}`,
        },
      ],
    });

    const text = (response.content[0] as { type: string; text: string }).text;

    // Parse "TICKER: insight" lines and group insights by ticker.
    const insightsByTicker = new Map<string, string[]>();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!/^[A-Z]{2,5}:/.test(line)) continue;
      const colonIdx = line.indexOf(":");
      const ticker = line.slice(0, colonIdx).trim().toUpperCase();
      const insight = line.slice(colonIdx + 1).trim();
      if (!insight || !tickers.includes(ticker)) continue;
      const arr = insightsByTicker.get(ticker) ?? [];
      arr.push(insight);
      insightsByTicker.set(ticker, arr);
    }

    if (!insightsByTicker.size) {
      console.log(`[memory] No insights parsed for ${tickers.join(", ")}`);
      return;
    }

    const col = db.collection("tickerMemory");
    // Never write more than the cap in a single run, so the per-ticker invariant
    // (<= MAX_INSIGHTS_PER_TICKER rows) holds even if the model over-produces.
    const entries = [...insightsByTicker.entries()].map(
      ([ticker, insights]) =>
        [ticker, insights.slice(0, MAX_INSIGHTS_PER_TICKER)] as const
    );

    // Bounded prune: count each ticker's rows (one cheap aggregate read), then
    // fetch ONLY the oldest N that must go so existing_kept + new == the cap.
    // The freshly-added rows are always the newest, so they're always kept.
    const pruneRefs = await Promise.all(
      entries.map(async ([ticker, insights]) => {
        const keepExisting = Math.max(0, MAX_INSIGHTS_PER_TICKER - insights.length);
        const countSnap = await col
          .where("userId", "==", userId)
          .where("ticker", "==", ticker)
          .count()
          .get();
        const existing = countSnap.data().count as number;
        const deleteCount = existing - keepExisting;
        if (deleteCount <= 0) return [];
        const oldSnap = await col
          .where("userId", "==", userId)
          .where("ticker", "==", ticker)
          .orderBy("createdAt", "asc")
          .limit(deleteCount)
          .get();
        return oldSnap.docs.map((d) => d.ref);
      })
    );

    // Single batched write: every add and every prune-delete in one commit.
    const now = new Date().toISOString();
    const batch = db.batch();
    let added = 0;
    for (const [ticker, insights] of entries) {
      for (const insight of insights) {
        batch.set(col.doc(), { userId, ticker, insight, source: null, createdAt: now });
        added++;
      }
    }
    for (const refs of pruneRefs) {
      for (const ref of refs) batch.delete(ref);
    }
    await batch.commit();

    console.log(`[memory] Saved ${added} insights for ${tickers.join(", ")}`);
  } catch (err) {
    console.error("[agentMemory] saveTickerMemory error:", err);
  }
}
