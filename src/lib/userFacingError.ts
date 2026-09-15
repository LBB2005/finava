/**
 * Turn any error headed for a user-visible surface (thinking trace, agent step,
 * saved message, Full modal) into plain copy with no vendor detail.
 *
 * Raw provider errors read like "402 Insufficient credits. Add more using
 * https://openrouter.ai/settings/credits" — they leak our vendor stack and
 * billing state, and they tell a user nothing they can act on. The raw error
 * still belongs in server logs; this is only for what a person reads.
 *
 * Deliberately a whitelist, not a blacklist: anything we don't recognise as our
 * own copy collapses to the generic line, so a new vendor's error format can't
 * slip through just because nobody added a pattern for it.
 *
 * Pure and dependency-free so client components can import it too.
 */

export const PROVIDER_UNAVAILABLE = "An AI provider was unavailable for this step.";
export const STEP_TIMED_OUT = "This step took too long and was skipped.";

// Our own per-agent wall-clock timeout (ceo.ts withTimeout): "<label> timed out after 60s".
const OWN_TIMEOUT = /\btimed out after \d+(\.\d+)?s\b/;

const USER_FACING = new Set([PROVIDER_UNAVAILABLE, STEP_TIMED_OUT]);

export function toUserFacingError(err: unknown): string {
  const message =
    typeof err === "string" ? err : err instanceof Error ? err.message : "";
  if (USER_FACING.has(message)) return message;
  if (OWN_TIMEOUT.test(message)) return STEP_TIMED_OUT;
  return PROVIDER_UNAVAILABLE;
}
