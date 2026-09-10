/* ============================================================
   Finava · Coverage beyond the S&P 500
   ------------------------------------------------------------
   Real retail portfolios aren't S&P-500-only. This adds:

   1. EXTRA_CONSTITUENTS — popular non-S&P US names + major ADRs
      that the factor engine CAN score (it fetches their data the
      same way). Merged into the universe in `factors.ts` (deduped
      against the S&P list), so they also enrich Research.

   2. ETF_PROFILES — hand-authored factor "character" for the most-
      held ETFs. ETFs have no fundamentals to score, and we don't
      want them ranked in the Research stock leaderboard, so they're
      handled in the Investor DNA layer only: they shape your tilt /
      archetype but never claim a stock-picking track record.

   Both are curated safety nets, not a live index — extend freely.
   ============================================================ */

import { SP500, type Constituent } from "@/lib/sp500";
import type { FactorScores } from "@/lib/research";

/** Popular non-S&P US names + major ADRs. Deduped against the S&P list at merge time. */
export const EXTRA_CONSTITUENTS: Constituent[] = [
  // ── High-interest non-S&P US names (membership churns; harmless if some are already in) ──
  { ticker: "HOOD", name: "Robinhood Markets", sector: "Financials" },
  { ticker: "SOFI", name: "SoFi Technologies", sector: "Financials" },
  { ticker: "AFRM", name: "Affirm Holdings", sector: "Financials" },
  { ticker: "MSTR", name: "Strategy (MicroStrategy)", sector: "Information Technology" },
  { ticker: "RBLX", name: "Roblox", sector: "Communication Services" },
  { ticker: "RDDT", name: "Reddit", sector: "Communication Services" },
  { ticker: "SNAP", name: "Snap", sector: "Communication Services" },
  { ticker: "RIVN", name: "Rivian Automotive", sector: "Consumer Discretionary" },
  { ticker: "LCID", name: "Lucid Group", sector: "Consumer Discretionary" },
  { ticker: "DKNG", name: "DraftKings", sector: "Consumer Discretionary" },
  { ticker: "CHWY", name: "Chewy", sector: "Consumer Discretionary" },
  { ticker: "U", name: "Unity Software", sector: "Information Technology" },
  { ticker: "SNOW", name: "Snowflake", sector: "Information Technology" },
  { ticker: "DOCU", name: "DocuSign", sector: "Information Technology" },
  { ticker: "ROKU", name: "Roku", sector: "Communication Services" },
  { ticker: "IONQ", name: "IonQ", sector: "Information Technology" },
  { ticker: "RKLB", name: "Rocket Lab", sector: "Industrials" },
  { ticker: "ASTS", name: "AST SpaceMobile", sector: "Industrials" },
  { ticker: "HIMS", name: "Hims & Hers Health", sector: "Health Care" },
  { ticker: "PATH", name: "UiPath", sector: "Information Technology" },
  // ── Major ADRs (foreign listings retail holds) ──
  { ticker: "TSM", name: "Taiwan Semiconductor (ADR)", sector: "Information Technology" },
  { ticker: "ASML", name: "ASML Holding (ADR)", sector: "Information Technology" },
  { ticker: "BABA", name: "Alibaba Group (ADR)", sector: "Consumer Discretionary" },
  { ticker: "TM", name: "Toyota Motor (ADR)", sector: "Consumer Discretionary" },
  { ticker: "SE", name: "Sea Limited (ADR)", sector: "Communication Services" },
  { ticker: "NVO", name: "Novo Nordisk (ADR)", sector: "Health Care" },
  { ticker: "AZN", name: "AstraZeneca (ADR)", sector: "Health Care" },
  { ticker: "NVS", name: "Novartis (ADR)", sector: "Health Care" },
  { ticker: "SAP", name: "SAP SE (ADR)", sector: "Information Technology" },
  { ticker: "SHOP", name: "Shopify", sector: "Information Technology" },
  { ticker: "SONY", name: "Sony Group (ADR)", sector: "Consumer Discretionary" },
  { ticker: "JD", name: "JD.com (ADR)", sector: "Consumer Discretionary" },
  { ticker: "PDD", name: "PDD Holdings (ADR)", sector: "Consumer Discretionary" },
  { ticker: "NIO", name: "NIO (ADR)", sector: "Consumer Discretionary" },
  { ticker: "UL", name: "Unilever (ADR)", sector: "Consumer Staples" },
];

/**
 * Every constituent the factor engine can score: the S&P 500 plus the extras
 * above, deduped in favour of the index list. This is the single scannable
 * universe — the server fan-out and the app's ticker autocomplete both read it,
 * so search never offers a name the engine cannot score.
 */
export const ALL_CONSTITUENTS: Constituent[] = (() => {
  const seen = new Set(SP500.map((c) => c.ticker));
  return [...SP500, ...EXTRA_CONSTITUENTS.filter((c) => !seen.has(c.ticker))];
})();

/** Ticker → constituent, over the full scannable universe. */
export const CONSTITUENT_BY_TICKER: Map<string, Constituent> = new Map(
  ALL_CONSTITUENTS.map((c) => [c.ticker, c]),
);

interface EtfProfile { name: string; sector: string; f: FactorScores }
const F = (mom: number, growth: number, quality: number, analyst: number, value: number, health: number): FactorScores =>
  ({ mom, growth, quality, analyst, value, health });

/**
 * Curated factor character for the most-held ETFs (each 0–100). Keys are looked
 * up by punctuation-stripped, upper-cased ticker (see `normalizeTicker`).
 */
export const ETF_PROFILES: Record<string, EtfProfile> = {
  // Broad market — close to neutral, mega-cap-weighted so a slight quality/growth lean.
  VOO: { name: "Vanguard S&P 500 ETF", sector: "Broad market ETF", f: F(60, 58, 60, 58, 45, 58) },
  IVV: { name: "iShares Core S&P 500 ETF", sector: "Broad market ETF", f: F(60, 58, 60, 58, 45, 58) },
  SPY: { name: "SPDR S&P 500 ETF", sector: "Broad market ETF", f: F(60, 58, 60, 58, 45, 58) },
  SPLG: { name: "SPDR Portfolio S&P 500 ETF", sector: "Broad market ETF", f: F(60, 58, 60, 58, 45, 58) },
  VTI: { name: "Vanguard Total Stock Market ETF", sector: "Broad market ETF", f: F(58, 56, 57, 56, 48, 56) },
  VV: { name: "Vanguard Large-Cap ETF", sector: "Broad market ETF", f: F(60, 58, 60, 57, 46, 57) },
  // Growth / tech tilt.
  QQQ: { name: "Invesco QQQ (Nasdaq-100)", sector: "Growth / tech ETF", f: F(75, 82, 68, 70, 22, 60) },
  QQQM: { name: "Invesco Nasdaq-100 ETF", sector: "Growth / tech ETF", f: F(75, 82, 68, 70, 22, 60) },
  VUG: { name: "Vanguard Growth ETF", sector: "Growth ETF", f: F(70, 80, 65, 62, 25, 58) },
  SCHG: { name: "Schwab US Large-Cap Growth ETF", sector: "Growth ETF", f: F(70, 80, 65, 62, 25, 58) },
  VGT: { name: "Vanguard Information Technology ETF", sector: "Growth / tech ETF", f: F(72, 78, 72, 68, 24, 62) },
  XLK: { name: "Technology Select Sector SPDR", sector: "Growth / tech ETF", f: F(72, 78, 72, 68, 24, 62) },
  ARKK: { name: "ARK Innovation ETF", sector: "Disruptive growth ETF", f: F(60, 92, 25, 45, 18, 30) },
  // Value / dividend / quality.
  SCHD: { name: "Schwab US Dividend Equity ETF", sector: "Dividend value ETF", f: F(45, 35, 75, 58, 78, 78) },
  VYM: { name: "Vanguard High Dividend Yield ETF", sector: "Dividend value ETF", f: F(45, 38, 68, 55, 72, 72) },
  VTV: { name: "Vanguard Value ETF", sector: "Value ETF", f: F(45, 32, 65, 55, 80, 68) },
  DGRO: { name: "iShares Core Dividend Growth ETF", sector: "Dividend value ETF", f: F(48, 42, 70, 56, 66, 72) },
  VIG: { name: "Vanguard Dividend Appreciation ETF", sector: "Dividend value ETF", f: F(50, 45, 72, 58, 60, 74) },
  JEPI: { name: "JPMorgan Equity Premium Income ETF", sector: "Income ETF", f: F(40, 30, 70, 55, 60, 75) },
  // Small cap.
  IWM: { name: "iShares Russell 2000 ETF", sector: "Small-cap ETF", f: F(48, 50, 40, 48, 60, 42) },
  IJR: { name: "iShares Core S&P Small-Cap ETF", sector: "Small-cap ETF", f: F(48, 50, 45, 48, 62, 46) },
  VB: { name: "Vanguard Small-Cap ETF", sector: "Small-cap ETF", f: F(48, 50, 44, 48, 60, 46) },
  // International.
  VEA: { name: "Vanguard FTSE Developed Markets ETF", sector: "International ETF", f: F(45, 45, 50, 50, 62, 54) },
  VXUS: { name: "Vanguard Total International Stock ETF", sector: "International ETF", f: F(45, 46, 48, 50, 63, 52) },
  EFA: { name: "iShares MSCI EAFE ETF", sector: "International ETF", f: F(45, 45, 50, 50, 62, 54) },
  VWO: { name: "Vanguard FTSE Emerging Markets ETF", sector: "Emerging markets ETF", f: F(48, 55, 42, 48, 65, 45) },
  IEMG: { name: "iShares Core MSCI Emerging Markets ETF", sector: "Emerging markets ETF", f: F(48, 55, 42, 48, 65, 45) },
  // Sector SPDRs.
  XLF: { name: "Financial Select Sector SPDR", sector: "Financials sector ETF", f: F(52, 42, 60, 55, 65, 60) },
  XLE: { name: "Energy Select Sector SPDR", sector: "Energy sector ETF", f: F(50, 40, 55, 50, 75, 58) },
  XLV: { name: "Health Care Select Sector SPDR", sector: "Health sector ETF", f: F(45, 45, 68, 58, 55, 70) },
};
