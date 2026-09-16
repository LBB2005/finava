// The one loader for a ticker's numbers. Server-only.
//
// Fast fields (quote, fundamentals, filings, calendar, Street) come from the
// in-process memo; score + DCF come from the global Firestore tier and are
// computed on a miss unless `cachedOnly`. Every source is failure-isolated and
// optionally raced against a deadline; what failed is listed in `dropped`.

import { getQuote, getBasicFinancials, getEarningsCalendar, getPriceTarget } from "@/lib/finnhub";
import { getCikByTicker, getCompanyFacts } from "@/lib/edgar";
import { pickNextEarnings, type EarningsCalendarRow } from "@/agents/sub-agents/earnings-agent";
import { getStockBundle } from "@/lib/stockData";
import { assembleScoreInputs, finishDcfInputs } from "@/lib/finavaInputs";
import { computeFinavaScore } from "@/lib/finavaScore";
import { defaultFairValue, defaultGrowthFor } from "@/lib/dcf";
import { grade } from "@/lib/research";
import { memo, readDerived, writeDerived, type Derived } from "./cache";
import { buildFastFacts, quoteFacts, snapshotEdgar, SRC, type EdgarSnapshot, type FastFacts, type SourceError, type SourceName } from "./fast";
import { peerPremiumPct } from "./signals";
import {
  fact, missing, toSlim, SCORE_VERSION, DCF_VERSION, TERMINAL_GROWTH,
  type Fact, type ScoreFact, type DcfFact, type TickerFacts, type TickerFactsSlim,
} from "./types";

export interface GetTickerFactsOptions {
  /** Demand fresher data than the default TTLs. */
  maxAgeSec?: number;
  /** Read score/DCF from cache only; never run the expensive assembly. */
  cachedOnly?: boolean;
  /** Ignore cached score/DCF and recompute (a user-requested run). */
  refreshDerived?: boolean;
  /** Total budget in ms; sources still pending are dropped. */
  deadlineMs?: number;
  now?: () => Date;
}

class DeadlineError extends Error {}

function race<T>(p: Promise<T>, deadline: number | undefined): Promise<T> {
  if (deadline == null) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError("timeout")), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([p, timeout]).finally(() => timer && clearTimeout(timer));
}

function easternDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

function plusDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const capitalize = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const computing = new Map<string, Promise<Derived>>();

/** Sources the score and DCF are built from. If one is failing (a 429, a timeout),
 *  computing now would cache a degraded score for 24 h, so we wait instead. */
const SCORING_INPUTS: { name: SourceName; label: string }[] = [
  { name: "quote", label: "price" },
  { name: "metric", label: "fundamentals" },
  { name: "edgar", label: "filings" },
];

async function computeDerived(
  t: string,
  fast: FastFacts,
  edgar: EdgarSnapshot | null,
  metric: Record<string, unknown> | null,
  have: Derived,
  now: () => Date
): Promise<Derived> {
  const asOf = now().toISOString();

  let dcf: Fact<DcfFact> | null = have.dcf;
  if (!dcf) {
    const base = edgar?.dcfBase ?? null;
    if (!edgar) dcf = missing(SRC.dcf, "SEC filings unavailable right now", asOf);
    else if (!edgar.hasFilings || !base) dcf = missing(SRC.dcf, "No SEC filings for this symbol", asOf);
    else {
      const inputs = finishDcfInputs(base, {
        price: fast.price.value, beta: fast.beta.value, marketCapMillions: num(metric?.marketCapitalization), currency: "USD",
      });
      const positiveFcf = inputs.baseFcf != null && inputs.baseFcf > 0;
      const fairValue = positiveFcf ? defaultFairValue(inputs) : null;
      dcf = fairValue == null
        ? missing(SRC.dcf, positiveFcf ? "Shares outstanding unavailable" : "No positive free cash flow in filings", asOf)
        : fact<DcfFact>(
            { fairValue, wacc: inputs.suggestedWacc, growth: defaultGrowthFor(inputs), terminal: TERMINAL_GROWTH, inputs, version: DCF_VERSION },
            { source: SRC.dcf, asOf, unit: "USD" }
          );
    }
  }

  let score: Fact<ScoreFact> | null = have.score;
  if (!score) {
    const bundle = await getStockBundle(t).catch(() => null);
    const inputs = await assembleScoreInputs(
      t, fast.price.value, bundle?.insider ?? null, bundle?.sentiment?.score ?? null, bundle?.profile?.name ?? t,
      {
        dcf: {
          dcfFair: dcf.value?.fairValue ?? null,
          fcfConversion: edgar?.dcfBase?.fcfConversion ?? null,
          revenueCagr3y: edgar?.dcfBase?.revenueCagr3y ?? null,
        },
        peTTM: fast.pe.value,
      }
    );
    const r = computeFinavaScore(inputs);
    score = r.coverage === 0
      ? missing(SRC.score, "No factor data available for this symbol", asOf)
      : fact<ScoreFact>(
          {
            total: r.score, grade: grade(r.score), pillars: r.pillars, confidence: r.confidence,
            coverage: r.coverage, peerPremiumPct: peerPremiumPct(inputs), version: SCORE_VERSION,
          },
          { source: SRC.score, asOf }
        );
  }

  // Persist only what this call computed, so re-deriving a missing DCF never
  // silently extends a cached score's 24 h life.
  await writeDerived(t, { score: have.score ? null : score, dcf: have.dcf ? null : dcf }, now());
  return { score, dcf };
}

export async function getTickerFacts(raw: string, opts: GetTickerFactsOptions = {}): Promise<TickerFacts> {
  const t = raw.trim().toUpperCase();
  const now = opts.now ?? (() => new Date());
  const deadline = opts.deadlineMs != null ? Date.now() + opts.deadlineMs : undefined;
  const errors: Partial<Record<SourceName, SourceError>> = {};
  const m = { maxAgeSec: opts.maxAgeSec, now };

  const run = async <T>(name: SourceName, load: () => Promise<{ value: T; at: number }>) => {
    try {
      return await race(load(), deadline);
    } catch (err) {
      errors[name] = err instanceof DeadlineError ? "timeout" : "error";
      console.warn(`[facts] ${t} ${name} ${errors[name]}:`, err instanceof Error ? err.message : err);
      return null;
    }
  };

  const today = easternDay(now());
  const [quote, metric, edgar, earnings, target, cached] = await Promise.all([
    run("quote", () => memo(`quote:${t}`, "quote", () => getQuote(t), m)),
    run("metric", () =>
      memo(`metric:${t}`, "day", async () => ((await getBasicFinancials(t)) as { metric?: Record<string, unknown> } | null)?.metric ?? null, m)),
    run("edgar", () =>
      memo(`edgar:${t}`, "day", async () => {
        const cik = await getCikByTicker(t);
        return snapshotEdgar(cik ? await getCompanyFacts(cik) : null);
      }, m)),
    run("earnings", () =>
      memo(`earnings:${t}`, "day", async () => {
        const res = (await getEarningsCalendar(today, plusDays(today, 120), t)) as { earningsCalendar?: EarningsCalendarRow[] } | null;
        return pickNextEarnings(res?.earningsCalendar ?? [], today);
      }, m)),
    run("target", () => memo(`target:${t}`, "day", () => getPriceTarget(t), m)),
    run("derived", async () => ({
      value: opts.refreshDerived ? { score: null, dcf: null } : await readDerived(t, m),
      at: now().getTime(),
    })),
  ]);

  // A metric payload with no `metric` object is "not reported", not a failure.
  const metricLoaded = metric?.value ? { value: metric.value, at: metric.at } : null;
  const fast = buildFastFacts(t, { quote, metric: metricLoaded, edgar, earnings, target, errors });

  let derived: Derived = cached?.value ?? { score: null, dcf: null };
  const failingInputs = SCORING_INPUTS.filter((s) => errors[s.name]).map((s) => s.label);
  if (!opts.cachedOnly && failingInputs.length === 0 && (!derived.score || !derived.dcf)) {
    const have = derived;
    let job = computing.get(t);
    if (!job) {
      job = computeDerived(t, fast, edgar?.value ?? null, metric?.value ?? null, have, now).finally(() => computing.delete(t));
      computing.set(t, job);
    }
    const done = await run("derived", async () => ({ value: await job!, at: now().getTime() }));
    if (done) derived = done.value;
  }

  const asOf = now().toISOString();
  const pendingNote = opts.cachedOnly
    ? "Not scored yet"
    : failingInputs.length
      ? `${capitalize(failingInputs.join(", "))} unavailable right now. Try again shortly.`
      : errors.derived === "timeout"
        ? "Not retrieved in time"
        : "Couldn't compute right now";
  return {
    ticker: t,
    ...fast,
    score: derived.score ?? missing(SRC.score, pendingNote, asOf),
    dcf: derived.dcf ?? missing(SRC.dcf, opts.cachedOnly ? "Not computed yet" : pendingNote, asOf),
    dropped: Object.keys(errors),
  };
}

/** Price, day change and cached score only: what a holdings row needs. Cheap. */
export async function getTickerQuoteFacts(
  raw: string,
  opts: Pick<GetTickerFactsOptions, "now"> = {}
): Promise<Pick<TickerFacts, "ticker" | "price" | "change1d" | "score">> {
  const t = raw.trim().toUpperCase();
  const now = opts.now ?? (() => new Date());
  const errors: Partial<Record<SourceName, SourceError>> = {};
  const [quote, derived] = await Promise.all([
    memo(`quote:${t}`, "quote", () => getQuote(t), { now }).catch(() => {
      errors.quote = "error";
      return null;
    }),
    readDerived(t, { now }),
  ]);
  return {
    ticker: t,
    ...quoteFacts(quote, errors),
    score: derived.score ?? missing(SRC.score, "Not scored yet", now().toISOString()),
  };
}

/** Cache-only score headlines for list rows. Never calls a market-data vendor. */
export async function getTickerFactsSlim(
  tickers: string[],
  opts: Pick<GetTickerFactsOptions, "now"> = {}
): Promise<TickerFactsSlim[]> {
  const now = opts.now ?? (() => new Date());
  return Promise.all(
    tickers.map(async (raw) => {
      const t = raw.trim().toUpperCase();
      const d = await readDerived(t, { now });
      return toSlim({
        ticker: t,
        score: d.score ?? missing(SRC.score, "Not scored yet. Open the stock page to compute it.", now().toISOString()),
      });
    })
  );
}
