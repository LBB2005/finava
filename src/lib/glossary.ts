import { DEFAULT_EXPERIENCE_LEVEL, type ExperienceLevel } from "./experienceLevel";

/**
 * Plain-English definitions for the jargon beta testers hit and could not
 * decode. One sentence each, no jargon inside the definition, no numbers that
 * could go stale.
 */
export const GLOSSARY: Record<string, string> = {
  "P/E": "Price divided by earnings per share — what you pay for each dollar the company earns in a year.",
  "P/S": "Price divided by revenue per share — used when a company has growth but no profits yet.",
  "P/B": "Price divided by book value per share — how the market values the company against its accounting net worth.",
  "PEG": "The P/E ratio divided by the earnings growth rate, so a fast grower can look cheaper than its P/E suggests.",
  "EPS": "Earnings per share — the company's profit divided by the number of shares outstanding.",
  "EV/EBITDA": "Enterprise value divided by earnings before interest, tax, depreciation and amortisation — a valuation measure that ignores how the company is financed.",
  "EBITDA": "Profit before interest, tax, depreciation and amortisation — a rough proxy for cash earnings from operations.",
  "enterprise value": "The cost of buying the whole business: its market value plus debt, minus the cash you would inherit.",
  "market cap": "The total value of all a company's shares at today's price.",
  "free cash flow": "The cash left over after running the business and paying for equipment and buildings.",
  "FCF": "Free cash flow — the cash left after running the business and paying for equipment and buildings.",
  "DCF": "Discounted cash flow — an estimate of what a business is worth today based on the cash it is expected to produce in future.",
  "WACC": "The blended rate a company pays for its debt and equity, used as the discount rate in a valuation.",
  "terminal value": "The share of a valuation that comes from everything beyond the forecast years.",
  "discount rate": "The annual rate used to shrink future cash to what it is worth today.",
  "margin of safety": "The gap between a stock's price and your estimate of its worth, kept as room for being wrong.",
  "intrinsic value": "What a business is worth based on the cash it can produce, regardless of today's share price.",
  "gross margin": "The share of revenue left after the direct cost of making the product.",
  "operating margin": "The share of revenue left as profit after the day-to-day costs of running the business.",
  "net margin": "The share of revenue left as profit after every cost, including tax and interest.",
  "ROE": "Return on equity — profit measured against the shareholders' money invested in the business.",
  "ROIC": "Return on invested capital — profit measured against all the money, debt and equity, put to work in the business.",
  "CAGR": "The steady annual growth rate that would get you from the starting value to the ending value.",
  "YoY": "Year over year — this period compared with the same period a year earlier.",
  "TTM": "Trailing twelve months — the last four reported quarters added together.",
  "guidance": "The company's own forecast for its coming results.",
  "consensus": "The average of Wall Street analysts' forecasts for a company.",
  "price target": "An analyst's estimate of where a share price will trade, usually within a year.",
  "beta": "How much a stock tends to move when the whole market moves — above 1 means it swings harder than the market.",
  "alpha": "Return above what the market gave you, after allowing for the risk taken.",
  "volatility": "How sharply a price swings up and down over time.",
  "drawdown": "The fall from a peak to the low that follows, as a percentage.",
  "Sharpe ratio": "Return earned per unit of the ups and downs endured to get it.",
  "standard deviation": "A measure of how far values typically stray from their average.",
  "correlation": "How closely two investments tend to move together, from -1 to 1.",
  "diversification": "Spreading money across different investments so one bad outcome cannot sink the whole portfolio.",
  "concentration": "How much of a portfolio sits in a single position or theme.",
  "hedge": "A position taken to offset losses in something else you own.",
  "RSI": "Relative strength index — a 0-100 gauge of how hard a stock has been bought or sold recently.",
  "MACD": "A momentum indicator comparing two moving averages to spot shifts in trend.",
  "SMA": "Simple moving average — the average closing price over a set number of days.",
  "EMA": "Exponential moving average — a moving average that weights recent days more heavily.",
  "support": "A price area where buyers have repeatedly stepped in before.",
  "resistance": "A price area where sellers have repeatedly capped the move before.",
  "moving average": "The average price over a rolling window of days, used to smooth out daily noise.",
  "momentum": "The tendency of a price that has been rising or falling to keep going that way for a while.",
  "short interest": "The share of a company's stock that traders have borrowed and sold, betting the price falls.",
  "float": "The number of shares actually available to trade, excluding locked-up insider holdings.",
  "liquidity": "How easily something can be bought or sold without moving its price.",
  "bid-ask spread": "The gap between the highest price a buyer offers and the lowest a seller accepts.",
  "13F": "A quarterly filing where large investment managers disclose the US stocks they hold.",
  "Form 4": "A filing an insider must make within two business days of buying or selling their own company's stock.",
  "10-K": "A company's annual report to the US regulator, with audited financial statements.",
  "10-Q": "A company's quarterly report to the US regulator, less detailed than the annual one.",
  "8-K": "A filing companies use to announce major events between regular reports.",
  "insider buying": "Purchases of a company's stock by its own executives or directors.",
  "institutional ownership": "The share of a company held by funds, pensions and other professional investors.",
  "ETF": "Exchange-traded fund — a basket of investments you can buy and sell as a single share.",
  "index fund": "A fund that simply holds everything in a market index rather than picking stocks.",
  "mutual fund": "A pooled fund priced once a day, bought directly from the fund company.",
  "expense ratio": "The yearly percentage a fund charges you for running it.",
  "AUM": "Assets under management — the total money a fund or manager looks after.",
  "NAV": "Net asset value — what one share of a fund's holdings is worth.",
  "dividend": "A cash payment a company makes to shareholders out of its profits.",
  "dividend yield": "The yearly dividend as a percentage of the share price.",
  "payout ratio": "The share of earnings a company pays out as dividends.",
  "buyback": "A company buying its own shares, which leaves each remaining share owning a bigger slice.",
  "APY": "Annual percentage yield — what you earn on savings in a year once compounding is counted.",
  "APR": "Annual percentage rate — the yearly cost of borrowing, including fees.",
  "basis point": "One hundredth of a percentage point.",
  "yield curve": "A chart of interest rates on government bonds across different maturities.",
  "inflation": "The rate at which prices rise, which eats into what your money buys.",
  "Fed funds rate": "The overnight interest rate the US central bank targets, which anchors other rates.",
  "recession": "A sustained, broad decline in economic activity.",
  "401(k)": "A retirement account offered through a US employer, funded from your pay before tax.",
  "IRA": "An individual retirement account you open yourself, with tax advantages and yearly limits.",
  "Roth IRA": "A retirement account funded with taxed money, where qualified withdrawals come out tax-free.",
  "capital gain": "The profit made when you sell something for more than you paid.",
  "cost basis": "What you originally paid for an investment, used to work out gain or loss.",
  "tax-loss harvesting": "Selling a loser to book the loss against gains elsewhere in the same tax year.",
  "wash sale": "Buying back essentially the same investment within 30 days of selling it at a loss, which voids the tax benefit.",
  "CFP": "Certified Financial Planner — a licensed adviser who can give you personalised financial advice.",
  "fiduciary": "An adviser legally required to act in your interest rather than their own.",
  "RIA": "Registered investment adviser — a firm registered to give personalised investment advice.",
  "options": "Contracts giving the right, not the obligation, to buy or sell a stock at a set price by a set date.",
  "call option": "A contract giving the right to buy a stock at a set price before a set date.",
  "put option": "A contract giving the right to sell a stock at a set price before a set date.",
  "implied volatility": "How much movement the options market is pricing in for a stock.",
  "put/call ratio": "The volume of put contracts against call contracts, read as a mood gauge.",
  "moat": "A durable advantage that makes it hard for competitors to take a company's profits.",
  "TAM": "Total addressable market — the whole revenue opportunity if a company captured every possible customer.",
  "churn": "The share of customers who leave over a period.",
  "ARR": "Annual recurring revenue — subscription revenue counted as a yearly run rate.",
  "backlog": "Orders a company has taken but not yet delivered and billed.",
  "capex": "Capital expenditure — money spent on long-lived assets like buildings and equipment.",
  "dilution": "The shrinking of your ownership share when a company issues more stock.",
};

export interface GlossaryHit {
  term: string;
  definition: string;
  start: number;
  end: number;
}

/** Longest-first so "EV/EBITDA" wins over "EBITDA". */
const TERMS_BY_LENGTH = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// A term is a hit only on a word boundary, so "betamax" is not "beta". The
// boundary is hand-rolled because \b does not work next to "/" or ")".
const EDGE = "[A-Za-z0-9]";
const patternFor = (term: string) =>
  new RegExp(`(?<!${EDGE})${escape(term)}(?:s|'s)?(?!${EDGE})`, "i");

/** Look a term up, tolerating case and a trailing plural. */
export function lookupTerm(term: string): string | undefined {
  const cleaned = term.trim().replace(/[.,;:]$/, "");
  const direct = Object.keys(GLOSSARY).find((k) => k.toLowerCase() === cleaned.toLowerCase());
  if (direct) return GLOSSARY[direct];
  const singular = cleaned.replace(/(?:'s|s)$/i, "");
  const plural = Object.keys(GLOSSARY).find((k) => k.toLowerCase() === singular.toLowerCase());
  return plural ? GLOSSARY[plural] : undefined;
}

/**
 * Find the first occurrence of each glossary term in `text`, skipping any term
 * already in `seen` (pass one set per message so a term is only ever marked
 * once). Hits never overlap and come back in reading order.
 */
export function findGlossaryHits(text: string, seen?: Set<string>): GlossaryHit[] {
  if (!text) return [];
  const hits: GlossaryHit[] = [];
  const taken: [number, number][] = [];

  for (const term of TERMS_BY_LENGTH) {
    if (seen?.has(term)) continue;
    const m = patternFor(term).exec(text);
    if (!m || m.index < 0) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (taken.some(([s, e]) => start < e && end > s)) continue;
    taken.push([start, end]);
    hits.push({ term, definition: GLOSSARY[term], start, end });
    seen?.add(term);
  }

  return hits.sort((a, b) => a.start - b.start);
}

/**
 * Tracks which terms a message has already marked, so the second mention of a
 * term is left alone.
 *
 * It is keyed by the text of the run it was marked in rather than by a counter,
 * because React renders the same tree more than once (StrictMode in dev, and
 * any re-render in production): re-marking the SAME run has to come out the
 * same way, while a later run of different text must not mark the term again.
 */
export class GlossaryMarks {
  private claimed = new Map<string, string>();

  /** Terms already claimed by some other run of text. */
  private blocked(runText: string): Set<string> {
    const out = new Set<string>();
    for (const [term, owner] of this.claimed) if (owner !== runText) out.add(term);
    return out;
  }

  /** Hits to mark in this run of text — stable across repeated renders. */
  hits(runText: string): GlossaryHit[] {
    const found = findGlossaryHits(runText, this.blocked(runText));
    for (const hit of found) {
      if (!this.claimed.has(hit.term)) this.claimed.set(hit.term, runText);
    }
    return found;
  }
}

/** Definitions are for readers who asked for them — professionals opted out. */
export function shouldShowGlossary(level: ExperienceLevel | undefined): boolean {
  return (level ?? DEFAULT_EXPERIENCE_LEVEL) !== "professional";
}
