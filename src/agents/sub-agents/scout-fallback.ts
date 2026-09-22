// Honest labels for the discovery scout's fallback shortlist. Kept apart from
// scout-agent.ts (which pulls in the factor universe and the LLM client) so the
// discovery synthesizer can recognise a fallback without importing all of that.

/**
 * Shown on every pick, the interpretation line and in the narrator instruction
 * when the scout's LLM ranking failed. The previous copy ("Top factor fit for
 * your request") and narrator line ("selected EXACTLY these") claimed a
 * selection that never happened: during the 13 Sep outage every Discover query
 * returned the same names, each dressed up as a match.
 */
export const SCOUT_UNAVAILABLE_LABEL =
  "Scout unavailable — showing today's highest overall factor scores, not a match for your request";
/** Same, when the user's explicit hard limits (sector / price / P/E) still applied. */
export const SCOUT_UNAVAILABLE_FILTERED_LABEL =
  "Scout unavailable — showing today's highest overall factor scores within your stated limits, not a ranked match for your request";

/**
 * Shown when the user's explicit hard limits (sector / price / P/E / size) match
 * no name in the universe. This is a real, informative answer — the screen ran
 * and nothing qualified — so it must never be dressed up as a shortlist. The
 * scout previously discarded the filter here and returned the universe's top
 * factor scores instead, presenting names that violated the stated limits.
 */
export const SCOUT_NO_MATCHES_LABEL =
  "No names in the S&P 500 match those limits right now";

/** Whether a pick came from the scout-unavailable fallback rather than a real ranking. */
export function isScoutFallbackPick(pick: { reason?: string }): boolean {
  return pick.reason === SCOUT_UNAVAILABLE_LABEL || pick.reason === SCOUT_UNAVAILABLE_FILTERED_LABEL;
}
