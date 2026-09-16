/**
 * Position merge math for the manual holdings book.
 *
 * Re-adding a ticker you already own used to silently overwrite the position —
 * a second purchase wiped the original lot's cost basis. The UI now asks
 * "Add to position" or "Replace"; these two functions are the arithmetic behind
 * that choice, kept pure so they can be tested without Firestore or SWR.
 */

export interface PositionInput {
  shares: number;
  avgCost: number;
  companyName?: string | null;
  sector?: string | null;
}

export interface MergedPosition {
  shares: number;
  avgCost: number;
  companyName: string | null;
  sector: string | null;
}

/**
 * Per-share cost is rounded to 6 decimals — far finer than a cent, but enough to
 * keep binary-float tails (0.30000000000000004) out of the stored document and
 * the rendered figure.
 */
const COST_DECIMALS = 6;

function round(n: number, decimals = COST_DECIMALS): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** A blank or whitespace-only label must not erase the one already on file. */
function pickLabel(incoming: string | null | undefined, existing: string | null | undefined): string | null {
  const next = incoming?.trim();
  if (next) return next;
  const current = existing?.trim();
  return current ? current : null;
}

/**
 * "Add to position": a second lot of the same ticker. Shares add; the cost basis
 * becomes the share-weighted average of the two lots, so total cost is preserved.
 *
 * A $0 cost lot (a gift, vested RSUs) is a real price and pulls the average down
 * — it is not treated as missing data.
 */
export function addToPosition(existing: PositionInput, incoming: PositionInput): MergedPosition {
  const shares = round(existing.shares + incoming.shares, 8);
  const avgCost =
    shares > 0
      ? round((existing.shares * existing.avgCost + incoming.shares * incoming.avgCost) / shares)
      : round(incoming.avgCost);

  return {
    shares,
    avgCost,
    companyName: pickLabel(incoming.companyName, existing.companyName),
    sector: pickLabel(incoming.sector, existing.sector),
  };
}

/**
 * "Replace": the entered lot becomes the whole position. Descriptive fields the
 * user left blank still fall back to what is already on file.
 */
export function replacePosition(existing: PositionInput, incoming: PositionInput): MergedPosition {
  return {
    shares: incoming.shares,
    avgCost: round(incoming.avgCost),
    companyName: pickLabel(incoming.companyName, existing.companyName),
    sector: pickLabel(incoming.sector, existing.sector),
  };
}
