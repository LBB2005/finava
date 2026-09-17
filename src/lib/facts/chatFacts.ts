// The facts a chat answer is written from. Server-only.
//
// One loader for the fast lane and the crew, so both quote the same numbers the
// stock page shows. Everything is optional and raced against one deadline: a
// source that is slow or down is named in `dropped` and its facts are missing,
// never guessed.

import type { TickerFacts } from "./types";
import type { FactsInput } from "./promptBlock";
import { insiderFacts } from "./precomputed";

const MAX_TICKERS = 3;

export interface LoadChatFactsOptions {
  tickers: string[];
  /** Load insider-transaction facts for the tickers. */
  insider?: boolean;
  /** Load this user's portfolio facts. */
  portfolioUserId?: string;
  deadlineMs: number;
  /** Read score/DCF from cache only (the fast lane never waits on a cold assembly). */
  cachedOnly?: boolean;
}

export interface ChatFacts {
  input: FactsInput;
  dropped: string[];
}

function within<T>(p: Promise<T>, deadline: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([p, timeout]).finally(() => timer && clearTimeout(timer));
}

const TIMEOUT = Symbol("timeout");

export async function loadChatFacts(opts: LoadChatFactsOptions): Promise<ChatFacts> {
  const deadline = Date.now() + opts.deadlineMs;
  const tickers = [...new Set(opts.tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_TICKERS);
  const dropped: string[] = [];

  // Loaded lazily (and once): these reach firebase-admin, which validates env at module load.
  const tickerModule = tickers.length ? import("./ticker") : null;
  const finnhubModule = opts.insider && tickers.length ? import("@/lib/finnhub") : null;

  const tickerJobs = tickers.map(async (t): Promise<TickerFacts | null> => {
    try {
      const { getTickerFacts } = await tickerModule!;
      const r = await within(getTickerFacts(t, { cachedOnly: opts.cachedOnly, deadlineMs: opts.deadlineMs }), deadline);
      if (r === TIMEOUT) throw new Error("timeout");
      return r;
    } catch {
      dropped.push(`${t} facts`);
      return null;
    }
  });

  const insiderJob = opts.insider
    ? Promise.all(
        tickers.map(async (t) => {
          const asOf = new Date().toISOString();
          try {
            const { getInsiderTransactions } = await finnhubModule!;
            const r = await within(getInsiderTransactions(t) as Promise<{ data?: [] } | null>, deadline);
            if (r === TIMEOUT) throw new Error("timeout");
            return insiderFacts(t, r ?? { data: [] }, asOf);
          } catch {
            if (!dropped.includes("insider")) dropped.push("insider");
            return insiderFacts(t, null, asOf);
          }
        })
      )
    : Promise.resolve(undefined);

  const portfolioJob = opts.portfolioUserId
    ? (async () => {
        try {
          const { getPortfolioFacts } = await import("./portfolio");
          const r = await within(getPortfolioFacts(opts.portfolioUserId!), deadline);
          if (r === TIMEOUT) throw new Error("timeout");
          return r;
        } catch {
          dropped.push("portfolio");
          return null;
        }
      })()
    : Promise.resolve(undefined);

  const [loaded, insider, portfolio] = await Promise.all([Promise.all(tickerJobs), insiderJob, portfolioJob]);

  const input: FactsInput = { tickers: loaded.filter((t): t is TickerFacts => t != null) };
  if (insider) input.insider = insider;
  if (portfolio !== undefined) input.portfolio = portfolio;
  return { input, dropped };
}
