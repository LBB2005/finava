/**
 * Per-round limits on the crew's tool calls.
 *
 * The CEO executes every tool call the model emits in a round, in parallel, and
 * the per-run credit cap is only checked between rounds — so the size of ONE
 * round was unbounded. A single prompt (or text injected via news/X/web content)
 * could ask for "one run_risk_agent call per ticker for these 150 names" and get
 * ~100 Sonnet runs plus hundreds of Finnhub calls in one go: tens of dollars past
 * the cap, and the shared Finnhub key rate-limited for every user. Two bounds fix
 * the shape of a round: each analyst runs at most once per round, and the list
 * arguments an analyst fans out over are clamped.
 */

/** Tickers one analyst call may fan out over. */
export const MAX_TICKERS_PER_CALL = 25;
/** The risk agent reads the user's whole book; allow a real portfolio's size. */
export const MAX_RISK_TICKERS = 100;
/** Peer / competitor lists (comparables, competitor, supply-chain agents). */
export const MAX_PEERS_PER_CALL = 10;

const TICKER_LIST_KEYS = ["tickers", "symbols"] as const;
const PEER_LIST_KEYS = ["peers", "competitors", "comparables"] as const;

/**
 * Clamp the fan-out lists in one tool call's input. Returns a shallow copy;
 * everything that isn't a list argument passes through untouched.
 */
export function clampToolInput(toolName: string, input: unknown, holdingsCount = 0): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const tickerCap =
    toolName === "run_risk_agent"
      ? Math.min(MAX_RISK_TICKERS, Math.max(MAX_TICKERS_PER_CALL, holdingsCount))
      : MAX_TICKERS_PER_CALL;
  for (const key of TICKER_LIST_KEYS) {
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).slice(0, tickerCap);
  }
  for (const key of PEER_LIST_KEYS) {
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).slice(0, MAX_PEERS_PER_CALL);
  }
  return out;
}

/**
 * Which tool_use blocks in a round actually run: the first call to each tool
 * name. Returns the ids of the rest, which must still get a tool_result (the
 * API rejects a turn that leaves a tool_use unanswered).
 */
export function duplicateToolCalls(blocks: { id: string; name: string }[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const b of blocks) {
    if (seen.has(b.name)) dupes.add(b.id);
    else seen.add(b.name);
  }
  return dupes;
}
