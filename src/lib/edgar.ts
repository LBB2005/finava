import { fetchWithRetry } from "@/lib/fetchRetry";

const EDGAR_BASE = "https://data.sec.gov";
const USER_AGENT = "Finava App liamblackshawbrown@gmail.com";

async function edgarFetch(url: string) {
  // Retry transient 429/5xx/network blips before giving up (see fetchWithRetry) —
  // SEC throttles bursts, and this is the factor engine's fundamentals fallback.
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": USER_AGENT },
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`EDGAR ${res.status}: ${url}`);
  return res.json();
}

// In-memory CIK cache — loaded once from SEC's static company tickers file
let CIK_CACHE: Record<string, string> | null = null;

async function getCikMap(): Promise<Record<string, string>> {
  if (CIK_CACHE) return CIK_CACHE;
  // Retried like every other SEC call: SEC throttles bursts. A load that still
  // fails THROWS. Returning an empty map here made every lookup answer "no such
  // company", which callers show as "no SEC filings" (the Sep-17 panel saw AT&T
  // that way) and the facts layer caches for a day. Only a successful load is kept.
  const res = await fetchWithRetry("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": USER_AGENT },
    next: { revalidate: 86400 }, // refresh daily
  });
  if (!res.ok) throw new Error(`SEC company tickers unavailable (${res.status})`);
  const data = await res.json();
  // { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, ... }
  const map: Record<string, string> = {};
  for (const entry of Object.values(data) as Array<{ cik_str: number; ticker: string }>) {
    map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, "0");
  }
  CIK_CACHE = map;
  return map;
}

// Resolve ticker → zero-padded 10-digit CIK string
export async function getCikByTicker(ticker: string): Promise<string | null> {
  const map = await getCikMap();
  return map[ticker.toUpperCase()] ?? null;
}

// Alias used by some modules
export const lookupCik = getCikByTicker;

export async function getCompanyFacts(cik: string) {
  const padded = cik.toString().padStart(10, "0");
  return edgarFetch(`${EDGAR_BASE}/api/xbrl/companyfacts/CIK${padded}.json`);
}

export async function getRecentFilings(cik: string) {
  const padded = cik.toString().padStart(10, "0");
  return edgarFetch(`${EDGAR_BASE}/submissions/CIK${padded}.json`);
}

/** Strip an EDGAR HTML filing to readable text: drop scripts/styles/tags, decode
 *  the common entities, and collapse whitespace. Intentionally cheap — the result
 *  is fed to an LLM, not rendered. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#\d+;|&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch the company's latest 10-K primary document and return it as plain text
 * (HTML stripped, truncated to `maxChars` — Item 1 "Business" with the customer/
 * supplier concentration disclosures sits near the front). Grounds the
 * supply-chain agent in the company's own words. Returns null when there's no
 * 10-K on file or the document can't be fetched.
 */
export async function getLatest10KText(cik: string, maxChars = 60_000): Promise<string | null> {
  try {
    const submissions = await getRecentFilings(cik);
    const recent = submissions?.filings?.recent;
    if (!recent || !Array.isArray(recent.form)) return null;
    const idx = recent.form.findIndex((f: string) => f === "10-K");
    if (idx === -1) return null;
    const accession = String(recent.accessionNumber?.[idx] ?? "").replace(/-/g, "");
    const doc = String(recent.primaryDocument?.[idx] ?? "");
    if (!accession || !doc) return null;
    // EDGAR Archives paths use the CIK without leading zeros.
    const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accession}/${doc}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    return htmlToText(await res.text()).slice(0, maxChars);
  } catch (err) {
    console.error("[edgar] getLatest10KText failed:", err);
    return null;
  }
}


// ── Reading raw XBRL facts ────────────────────────────────────────────────────
// SEC's calendar "frames" (CY2024Q3) only exist for periods that line up with a
// calendar quarter, so an off-calendar filer (AAPL: FY ends late Sep, MSFT: Jun,
// COST: 52/53 weeks to Aug/Sep) silently loses its fiscal Q4 — and with it every
// TTM total. Everything below therefore works from the period dates each fact
// carries, and ignores frames entirely.

/** Periodic reports only. A DEF 14A or 8-K figure is not a filed statement line. */
const FILING_FORM = /^10-[KQ](\/A)?$/;

/** Quarter length in days: 12 weeks (84) to a 17-week retail quarter (119), with slack. */
const Q_MIN_DAYS = 60;
const Q_MAX_DAYS = 125;
const FY_MIN_DAYS = 330;
const FY_MAX_DAYS = 400;

interface DurationFact { start: string; end: string; val: number; form: string; filed: string }
interface InstantFact { end: string; val: number; form: string; filed: string }

/** The day after `end` — a derived quarter starts where the previous one stopped. */
function dayAfter(end: string): string {
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawUnits(us: any, key: string): any[] {
  const units = us?.[key]?.units;
  if (!units) return [];
  return units.USD ?? units.shares ?? units["USD/shares"] ?? [];
}

/** Latest filing wins for a given period (restatements and amendments). */
function dedupeByPeriod<T extends { end: string; filed?: string }>(facts: T[], keyOf: (f: T) => string): T[] {
  const byPeriod = new Map<string, T>();
  for (const f of facts) {
    const key = keyOf(f);
    const prev = byPeriod.get(key);
    if (!prev || (f.filed ?? "") > (prev.filed ?? "")) byPeriod.set(key, f);
  }
  return [...byPeriod.values()];
}

/**
 * Duration facts for a concept, merged across `keys`. Issuers switch tags (Apple:
 * Revenues → RevenueFromContractWithCustomer…) and use sector-specific ones (JPM
 * reports total net revenue as RevenuesNetOfInterestExpense and left `Revenues`
 * behind in 2014), so the tag with the freshest data leads and the others only
 * back-fill periods it doesn't cover.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function durationFacts(us: any, keys: string[]): DurationFact[] {
  const perKey: DurationFact[][] = [];
  for (const key of keys) {
    const facts = rawUnits(us, key)
      .filter((u) => u?.start && u?.end && typeof u.val === "number" && FILING_FORM.test(u.form ?? ""))
      .map((u) => ({ start: u.start, end: u.end, val: u.val, form: u.form, filed: u.filed ?? "" }));
    const deduped = dedupeByPeriod(facts, (f) => `${f.start}|${f.end}`);
    if (deduped.length) perKey.push(deduped);
  }
  const freshest = (list: DurationFact[]) => list.reduce((a, f) => (f.end > a ? f.end : a), "");
  perKey.sort((a, b) => freshest(b).localeCompare(freshest(a)));

  const merged = new Map<string, DurationFact>();
  for (const list of perKey) {
    for (const f of list) {
      const key = `${f.start}|${f.end}`;
      if (!merged.has(key)) merged.set(key, f);
    }
  }
  return [...merged.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/** Instant (balance-sheet) facts for a concept, merged across `keys` as above. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function instantFacts(src: any, keys: string[]): InstantFact[] {
  const out: InstantFact[] = [];
  for (const key of keys) {
    for (const u of rawUnits(src, key)) {
      if (u?.start || !u?.end || typeof u.val !== "number") continue;
      if (!FILING_FORM.test(u.form ?? "")) continue;
      out.push({ end: u.end, val: u.val, form: u.form, filed: u.filed ?? "" });
    }
  }
  return dedupeByPeriod(out, (f) => f.end).sort((a, b) => a.end.localeCompare(b.end));
}

/**
 * Discrete fiscal quarters from raw duration facts.
 *
 * A 10-Q tags its own three-month column, so those are taken as filed. Fiscal Q4
 * is never filed on its own (the 10-K reports the year), and cash-flow concepts
 * are filed year-to-date throughout, so any period that continues an earlier one
 * from the same start date is de-cumulated: quarter = YTD(this) − YTD(previous).
 */
function quartersFromFacts(facts: DurationFact[]): QuarterlyMetric[] {
  const byEnd = new Map<string, QuarterlyMetric>();
  const add = (start: string, end: string, value: number) => {
    if (byEnd.has(end)) return;
    const d = new Date(end);
    byEnd.set(end, {
      year: d.getUTCFullYear(),
      quarter: (Math.ceil((d.getUTCMonth() + 1) / 3) as 1 | 2 | 3 | 4),
      value,
      start,
      end,
    });
  };

  for (const f of facts) {
    const span = daysBetween(f.start, f.end);
    if (span >= Q_MIN_DAYS && span <= Q_MAX_DAYS) add(f.start, f.end, f.val);
  }

  const byStart = new Map<string, DurationFact[]>();
  for (const f of facts) {
    const list = byStart.get(f.start);
    if (list) list.push(f);
    else byStart.set(f.start, [f]);
  }
  for (const list of byStart.values()) {
    const ladder = [...list].sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < ladder.length; i++) {
      const prev = ladder[i - 1];
      const cur = ladder[i];
      const gap = daysBetween(prev.end, cur.end);
      if (gap < Q_MIN_DAYS || gap > Q_MAX_DAYS) continue;
      add(dayAfter(prev.end), cur.end, cur.val - prev.val);
    }
  }

  // Issuers that tag only discrete quarters (no year-to-date column) still never
  // file a fiscal Q4 on its own: it is the year minus the three quarters inside it.
  for (const fy of facts) {
    const span = daysBetween(fy.start, fy.end);
    if (span < FY_MIN_DAYS || span > FY_MAX_DAYS) continue;
    if (byEnd.has(fy.end)) continue;
    const inside = [...byEnd.values()].filter((q) => q.start >= fy.start && q.end < fy.end);
    if (inside.length !== 3) continue;
    add(dayAfter(inside[inside.length - 1].end), fy.end, fy.val - inside.reduce((a, q) => a + q.value, 0));
  }

  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/**
 * Trailing twelve months: the last four quarters by end date. Null unless they
 * are genuinely consecutive and cover about a year — a gap means we would be
 * adding up the wrong window, and a wrong total is worse than "Unavailable".
 */
export interface TtmTotal { value: number; from: string; to: string }
export function ttmFromQuarters(series: QuarterlyMetric[]): TtmTotal | null {
  if (series.length < 4) return null;
  const last4 = series.slice(-4);
  for (let i = 1; i < last4.length; i++) {
    const gap = daysBetween(last4[i - 1].end, last4[i].end);
    if (gap < Q_MIN_DAYS || gap > Q_MAX_DAYS) return null;
  }
  const span = daysBetween(last4[0].start, last4[3].end);
  if (span < FY_MIN_DAYS || span > FY_MAX_DAYS) return null;
  return {
    value: last4.reduce((a, m) => a + m.value, 0),
    from: last4[0].start,
    to: last4[3].end,
  };
}

// Most recent annual value for a GAAP key: the fiscal year that ENDED last, not
// whatever happens to sit at the end of the array (companyfacts is filing-ordered,
// so a long-history filer can have an old restatement last).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickLatestAnnual(us: any, keys: string[]): number | null {
  const annual = annualFacts(us, keys);
  if (annual.length) return annual.at(-1)!.val;
  // Balance-sheet concepts have no duration — take the latest year-end instant.
  const instants = instantFacts(us, keys).filter((f) => f.form.startsWith("10-K"));
  return instants.at(-1)?.val ?? null;
}

/** Full-year duration facts (a fiscal year as filed in the 10-K). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function annualFacts(us: any, keys: string[]): DurationFact[] {
  return durationFacts(us, keys).filter((f) => {
    const span = daysBetween(f.start, f.end);
    return span >= FY_MIN_DAYS && span <= FY_MAX_DAYS;
  });
}

// Extract key financial metrics from company facts (single period — used by DCF agent)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractFinancialMetrics(facts: any) {
  const us = facts?.facts?.["us-gaap"] ?? {};
  return {
    revenue: pickLatestAnnual(us, REVENUE_TAGS),
    netIncome: pickLatestAnnual(us, NET_INCOME_TAGS),
    totalAssets: pickLatestAnnual(us, ["Assets"]),
    totalDebt: pickLatestAnnual(us, DEBT_TAGS),
    cash: pickLatestAnnual(us, CASH_TAGS),
    // Cash plus current marketable securities. Separate field so `cash` keeps
    // its narrow meaning for callers that already depend on it.
    cashAndShortTermInvestments: (() => {
      const cash = pickLatestAnnual(us, CASH_TAGS);
      const sti = pickLatestAnnual(us, SHORT_TERM_INVESTMENT_TAGS);
      return cash == null ? null : cash + (sti ?? 0);
    })(),
    operatingCashFlow: pickLatestAnnual(us, ["NetCashProvidedByUsedInOperatingActivities"]),
    // Capex is reported as a positive outflow under PaymentsToAcquire…; subtract it
    // from operating cash flow to get free cash flow. Absent for many filers — the
    // DCF route falls back to operating cash flow and flags it as a proxy.
    capex: pickLatestAnnual(us, ["PaymentsToAcquirePropertyPlantAndEquipment"]),
    sharesOutstanding: pickLatestAnnual(us, ["CommonStockSharesOutstanding"]),
  };
}

// ── Multi-year time series ─────────────────────────────────────────────────────

export interface YearlyMetric {
  year: number;
  value: number;
}

/**
 * Extract a multi-year annual time series, merging across the provided GAAP
 * concepts. When several `keys` are given, the concept whose data extends to the
 * most recent year is the base, and earlier-ending concepts only back-fill years
 * it doesn't cover. This stitches together issuers that switched tags mid-history
 * (e.g. Apple's `Revenues` → `RevenueFromContractWithCustomerExcludingAssessedTax`)
 * into one continuous series, rather than returning the first — possibly stale — tag.
 * Returns entries deduplicated by fiscal year, sorted ascending.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAnnualSeries(us: any, ...keys: string[]): YearlyMetric[] {
  const byYear = new Map<number, number>();
  const annual = annualFacts(us, keys);
  for (const f of annual) byYear.set(new Date(f.end).getUTCFullYear(), f.val);
  if (byYear.size === 0) {
    // Balance-sheet concepts: one instant per fiscal year end.
    for (const f of instantFacts(us, keys).filter((x) => x.form.startsWith("10-K"))) {
      byYear.set(new Date(f.end).getUTCFullYear(), f.val);
    }
  }
  return Array.from(byYear, ([year, value]) => ({ year, value })).sort((a, b) => a.year - b.year);
}

export interface FundamentalTimeSeries {
  revenue: YearlyMetric[];
  netIncome: YearlyMetric[];
  operatingIncome: YearlyMetric[];
  rAndD: YearlyMetric[];
  operatingCashFlow: YearlyMetric[];
  totalDebt: YearlyMetric[];
  cash: YearlyMetric[];
}

/**
 * Extract multi-year fundamental time series from EDGAR XBRL company facts.
 * Trims to the most recent `years` annual data points.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractFundamentalTimeSeries(facts: any, years = 5): FundamentalTimeSeries {
  const us = facts?.facts?.["us-gaap"] ?? {};
  const trim = (arr: YearlyMetric[]) => arr.slice(-years);

  return {
    revenue: trim(extractAnnualSeries(us, ...REVENUE_TAGS)),
    netIncome: trim(extractAnnualSeries(us, ...NET_INCOME_TAGS)),
    operatingIncome: trim(extractAnnualSeries(us, "OperatingIncomeLoss")),
    rAndD: trim(extractAnnualSeries(us, "ResearchAndDevelopmentExpense")),
    operatingCashFlow: trim(extractAnnualSeries(us, "NetCashProvidedByUsedInOperatingActivities")),
    totalDebt: trim(extractAnnualSeries(us, ...DEBT_TAGS)),
    cash: trim(extractAnnualSeries(us, ...CASH_TAGS)),
  };
}

// ── Quarterly time series (stock page v2 financials) ──────────────────────────

export interface QuarterlyMetric {
  /** Calendar year/quarter the period ENDS in — an off-calendar fiscal quarter
   *  is labelled by its end date (Apple's fiscal Q4 ends in calendar Q3). */
  year: number;
  quarter: 1 | 2 | 3 | 4;
  value: number;
  /** The fiscal period actually covered, as filed. */
  start: string;
  end: string;
}

// Concept lists, most-common tag first. Banks and insurers report a different
// revenue line (JPM: RevenuesNetOfInterestExpense) and some issuers only tag net
// income attributable to common shareholders (BKNG), so a single tag per concept
// silently reads as "no data" or, worse, as a decade-old figure.
const REVENUE_TAGS = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "RevenuesNetOfInterestExpense",
];
const NET_INCOME_TAGS = ["NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"];
const CASH_TAGS = ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsAndShortTermInvestments"];
const SHORT_TERM_INVESTMENT_TAGS = [
  "ShortTermInvestments",
  "MarketableSecuritiesCurrent",
  "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
  "OtherShortTermInvestments",
];
const DEBT_TAGS = ["LongTermDebt", "LongTermDebtNoncurrent"];

/** Discrete quarterly series for a concept, merged across `keys`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractQuarterlySeries(us: any, ...keys: string[]): QuarterlyMetric[] {
  return quartersFromFacts(durationFacts(us, keys));
}

export interface QuarterlyFundamentals {
  revenue: QuarterlyMetric[];
  grossProfit: QuarterlyMetric[];
  costOfRevenue: QuarterlyMetric[];
  netIncome: QuarterlyMetric[];
  operatingIncome: QuarterlyMetric[];
  operatingCashFlow: QuarterlyMetric[];
  capex: QuarterlyMetric[];
  buybacks: QuarterlyMetric[];
}

/**
 * Discrete quarterly fundamentals for the stock page's ledger/trajectory.
 * `quarters` trims each series to the most recent N (default 12 so the caller
 * can compute YoY for the last 8). Missing concepts → empty arrays; the UI
 * renders gaps as "—" (Data Accuracy Rule — never invent).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractQuarterlyFundamentals(facts: any, quarters = 12): QuarterlyFundamentals {
  const us = facts?.facts?.["us-gaap"] ?? {};
  const trim = (arr: QuarterlyMetric[]) => arr.slice(-quarters);
  return {
    revenue: trim(
      extractQuarterlySeries(us, ...REVENUE_TAGS)
    ),
    grossProfit: trim(extractQuarterlySeries(us, "GrossProfit")),
    costOfRevenue: trim(
      extractQuarterlySeries(us, "CostOfRevenue", "CostOfGoodsAndServicesSold")
    ),
    netIncome: trim(extractQuarterlySeries(us, ...NET_INCOME_TAGS)),
    operatingIncome: trim(extractQuarterlySeries(us, "OperatingIncomeLoss")),
    operatingCashFlow: trim(
      extractQuarterlySeries(us, "NetCashProvidedByUsedInOperatingActivities")
    ),
    capex: trim(extractQuarterlySeries(us, "PaymentsToAcquirePropertyPlantAndEquipment")),
    buybacks: trim(extractQuarterlySeries(us, "PaymentsForRepurchaseOfCommonStock")),
  };
}

export interface BalanceSnapshot {
  cash: number | null;
  /** Cash + current marketable securities — what "the cash pile" usually means.
   *  Kept separate from `cash` so neither is silently redefined. */
  cashAndShortTermInvestments: number | null;
  totalDebt: number | null;
  totalAssets: number | null;
  equity: number | null;
  sharesOutstanding: number | null;
  asOf: string | null; // balance-sheet date of the freshest fact used
}

/** A balance figure this far behind the freshest one is a leftover tag, not the
 *  current balance sheet (JPM last tagged LongTermDebt in 2014). */
const STALE_INSTANT_DAYS = 400;

/**
 * Latest balance sheet, read from the period dates rather than SEC's calendar
 * frames, so off-calendar filers aren't skipped. Any concept the issuer stopped
 * tagging is returned as null: "Unavailable" beats a decade-old number.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractBalanceSnapshot(facts: any): BalanceSnapshot {
  const us = facts?.facts?.["us-gaap"] ?? {};
  const dei = facts?.facts?.dei ?? {};

  const latest = (src: unknown, keys: string[]): InstantFact | null =>
    instantFacts(src, keys).at(-1) ?? null;

  const cash = latest(us, CASH_TAGS);
  const shortTermInvestments = latest(us, SHORT_TERM_INVESTMENT_TAGS);
  const debt = latest(us, DEBT_TAGS);
  const assets = latest(us, ["Assets"]);
  const equity = latest(us, [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ]);
  const shares =
    latest(us, ["CommonStockSharesOutstanding"]) ?? latest(dei, ["EntityCommonStockSharesOutstanding"]);

  // The balance-sheet date, from balance-sheet facts only. The cover-page share
  // count is dated later (filing day) and would misdate the whole snapshot.
  const asOf = [cash, shortTermInvestments, debt, assets, equity]
    .map((x) => x?.end)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1) ?? null;

  const fresh = (f: InstantFact | null): number | null =>
    f && asOf && daysBetween(f.end, asOf) <= STALE_INSTANT_DAYS ? f.val : null;

  const cashVal = fresh(cash);
  const stiVal = fresh(shortTermInvestments);

  return {
    cash: cashVal,
    // The combined tag already includes short-term investments; only add a
    // separate securities line when cash is the narrow concept.
    cashAndShortTermInvestments:
      cashVal == null
        ? null
        : cash?.end === shortTermInvestments?.end && stiVal != null
          ? cashVal + stiVal
          : cashVal,
    totalDebt: fresh(debt),
    totalAssets: fresh(assets),
    equity: fresh(equity),
    sharesOutstanding: fresh(shares),
    asOf,
  };
}

/**
 * Shares outstanding as of the latest filing's cover page (dei), which is a
 * current count — unlike the weighted average in an annual income statement,
 * which is stated in PRE-SPLIT shares until the next 10-K. Multiplying that
 * stale count by today's price is how a post-split issuer ends up with a market
 * cap (and P/E) off by the split factor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractCurrentSharesOutstanding(facts: any): { shares: number; asOf: string } | null {
  const dei = facts?.facts?.dei ?? {};
  const us = facts?.facts?.["us-gaap"] ?? {};
  const best =
    instantFacts(dei, ["EntityCommonStockSharesOutstanding"]).at(-1) ??
    instantFacts(us, ["CommonStockSharesOutstanding"]).at(-1);
  return best ? { shares: best.val, asOf: best.end } : null;
}

// ── EDGAR full-text search for Form 4 filings ─────────────────────────────────

export interface Form4Filing {
  entityName: string;
  filedAt: string;
  periodOfReport: string;
  accessionNo: string;
  cik: string;
}

/**
 * Search EDGAR full-text search for recent Form 4 filings mentioning a ticker.
 * Returns up to `limit` results filed within the last `daysBack` days.
 */
export async function searchRecentForm4(ticker: string, daysBack = 3, limit = 10): Promise<Form4Filing[]> {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - daysBack);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22&forms=4&startdt=${fmt(from)}&enddt=${fmt(today)}`;

  // Deliberately NOT swallowing fetch errors: an empty array must mean "no
  // filings in the window," not "the lookup failed." The caller relies on a
  // thrown error to tell those apart so it never reports a network failure as
  // "no insider activity."
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`EDGAR FTS ${res.status}`);
  const data = await res.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hits: any[] = data.hits?.hits ?? [];
  return hits.slice(0, limit).map((hit) => {
    const src = hit._source ?? {};
    const names: string[] = Array.isArray(src.display_names) ? src.display_names : [];
    const ciks: string[] = Array.isArray(src.ciks) ? src.ciks : [];
    // For a Form 4, display_names[0]/ciks[0] are the reporting owner (the
    // insider); the issuer is the second entry. Strip the "(CIK …)" suffix
    // EDGAR appends to display names.
    const insiderName = (names[0] ?? "").replace(/\s*\(CIK\s+\d+\)\s*$/i, "").trim();
    return {
      entityName: insiderName,
      filedAt: src.file_date ?? "",
      periodOfReport: src.period_ending ?? "",
      accessionNo: src.adsh ?? (typeof hit._id === "string" ? hit._id.split(":")[0] : ""),
      cik: ciks[0] ?? "",
    };
  });
}
