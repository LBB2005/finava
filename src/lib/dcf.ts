// Discounted-cash-flow model — pure functions shared by the DCF API route (which
// builds the base inputs from EDGAR/Finnhub) and the interactive DcfTab (which
// recomputes the fair value live as the user drags the WACC / growth sliders).
//
// Deliberately simple and transparent: a 5-year explicit free-cash-flow projection
// growing at `growth`, plus a Gordon-growth terminal value, discounted at `wacc`,
// less net debt, divided by shares outstanding. This is research color, not a
// precision valuation — capex data is sparse on EDGAR so `baseFcf` may fall back to
// operating cash flow (flagged via `fcfIsProxy`).

export interface DcfInputs {
  baseFcf: number | null; // latest annual free cash flow (USD)
  fcfIsProxy: boolean; // true when capex was unavailable and FCF == operating cash flow
  sharesOutstanding: number | null;
  netDebt: number | null; // total debt − cash (USD); can be negative (net cash)
  historicalGrowth: number | null; // revenue CAGR over available years, as a fraction (0.12 = 12%)
  suggestedWacc: number; // fraction (0.09 = 9%)
  currentPrice: number | null;
  currency: string | null;
}

/**
 * Why a fair value could not be produced. Named rather than boolean so the UI can
 * say WHICH input was missing instead of "unavailable" with no explanation.
 */
export type DcfGap =
  | "no_fcf"
  | "invalid_wacc"
  | "net_debt_unknown"
  | "shares_unknown"
  | "terminal_growth_exceeds_wacc";

export interface DcfResult {
  fairValue: number | null; // intrinsic value per share
  equityValue: number | null; // total equity value
  pvExplicit: number; // PV of the 5 explicit-period cash flows
  pvTerminal: number; // PV of the terminal value
  upsidePct: number | null; // vs currentPrice
  /** Empty when the model ran fully. Populated instead of guessing an input. */
  gaps: DcfGap[];
}

export interface DcfAssumptions {
  wacc: number; // fraction
  growth: number; // explicit-period FCF growth, fraction
  years?: number; // explicit projection horizon (default 5)
  terminalGrowth?: number; // perpetual growth, fraction (default 0.025)
}

/** CAPM-flavoured WACC suggestion from beta. Risk-free 4% + beta·5% equity premium,
 *  clamped to a sane 7–13% band so a wild beta can't produce a nonsensical rate. */
export function suggestedWaccFromBeta(beta: number | null): number {
  const RISK_FREE = 0.04;
  const EQUITY_PREMIUM = 0.05;
  const b = beta != null && Number.isFinite(beta) ? beta : 1;
  const raw = RISK_FREE + b * EQUITY_PREMIUM;
  return Math.min(0.13, Math.max(0.07, raw));
}

/** Run the DCF. Returns nulls for fairValue/equityValue when inputs are insufficient
 *  (no FCF or no shares), but always returns the PV components it could compute. */
export function computeDcf(inputs: DcfInputs, a: DcfAssumptions): DcfResult {
  const years = a.years ?? 5;
  const terminalGrowth = a.terminalGrowth ?? 0.025;
  const { baseFcf, sharesOutstanding, netDebt, currentPrice } = inputs;

  const empty = (gaps: DcfGap[]): DcfResult => ({
    fairValue: null,
    equityValue: null,
    pvExplicit: 0,
    pvTerminal: 0,
    upsidePct: null,
    gaps,
  });

  if (baseFcf == null || baseFcf <= 0) return empty(["no_fcf"]);
  if (!Number.isFinite(a.wacc) || a.wacc <= 0) return empty(["invalid_wacc"]);

  // Gordon growth requires g < WACC or the denominator is zero or negative. This
  // used to clamp silently to `wacc - 0.005`, which produced an enormous terminal
  // value that looked precise and was arbitrary — a fabricated number. Refuse it.
  if (terminalGrowth >= a.wacc) return empty(["terminal_growth_exceeds_wacc"]);
  const tg = terminalGrowth;

  let pvExplicit = 0;
  let lastFcf = baseFcf;
  for (let t = 1; t <= years; t++) {
    lastFcf = lastFcf * (1 + a.growth);
    pvExplicit += lastFcf / Math.pow(1 + a.wacc, t);
  }

  // Terminal value at end of the explicit horizon, discounted back.
  const terminalFcf = lastFcf * (1 + tg);
  const terminalValue = terminalFcf / (a.wacc - tg);
  const pvTerminal = terminalValue / Math.pow(1 + a.wacc, years);

  const enterpriseValue = pvExplicit + pvTerminal;

  // A null netDebt is UNKNOWN, not zero. Treating it as zero silently published a
  // fair value as if the company had no debt and no cash — and because netDebt was
  // assembled as `(totalDebt ?? 0) - (cash ?? 0)`, a company with unknown debt and
  // known cash produced phantom NET CASH, inflating the very companies whose
  // filings are thinnest. Enterprise value is still reported; the equity bridge is
  // not guessed.
  const gaps: DcfGap[] = [];
  if (netDebt == null) gaps.push("net_debt_unknown");
  if (!(sharesOutstanding && sharesOutstanding > 0)) gaps.push("shares_unknown");

  const equityValue = netDebt == null ? null : enterpriseValue - netDebt;
  const fairValue =
    equityValue != null && sharesOutstanding && sharesOutstanding > 0
      ? equityValue / sharesOutstanding
      : null;
  const upsidePct =
    fairValue != null && currentPrice && currentPrice > 0
      ? ((fairValue - currentPrice) / currentPrice) * 100
      : null;

  return { fairValue, equityValue, pvExplicit, pvTerminal, upsidePct, gaps };
}

/** The default growth assumption: historical revenue CAGR clamped to [0, 25%],
 *  else 8%. Shared by defaultFairValue, the DCF tab's slider start position,
 *  and the intelligence rail — so they can never disagree. */
export function defaultGrowthFor(inputs: Pick<DcfInputs, "historicalGrowth">): number {
  return inputs.historicalGrowth != null
    ? Math.min(0.25, Math.max(0, inputs.historicalGrowth))
    : 0.08;
}

/** Convenience: the fair value under the suggested/default assumptions. Used by the
 *  Finava synthesis to feed the three-way valuation comparison. */
export function defaultFairValue(inputs: DcfInputs): number | null {
  return computeDcf(inputs, {
    wacc: inputs.suggestedWacc,
    growth: defaultGrowthFor(inputs),
  }).fairValue;
}
