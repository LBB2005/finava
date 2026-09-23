// Whether the investment-research UI should render. Client-safe.
//
// This is a VISIBILITY flag, not a security boundary. A NEXT_PUBLIC_ value is
// inlined into the browser bundle, so anyone can read it and anyone can fake the
// client state it drives. The authoritative gate is the server-side
// `investmentResearchEnabled()` check on every /api/investment route: with that
// off, the routes refuse regardless of what the client believes.
//
// Both read `=== "true"` so a typo hides the feature rather than exposing it.
//
// The env var is referenced STATICALLY on purpose — Next only inlines
// `process.env.NEXT_PUBLIC_X` when it appears literally, so a dynamic lookup
// would silently evaluate to undefined in the browser.

export function investmentResearchVisible(): boolean {
  return process.env.NEXT_PUBLIC_INVESTMENT_RESEARCH_ENABLED === "true";
}
