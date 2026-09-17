/**
 * Insider Agent v2
 * Combines two data sources:
 *   A) SEC EDGAR full-text search for Form 4 filings (last 48h)
 *      — filters purchases (type P) only, > $100K threshold, ranked by value
 *   B) Finnhub insider transactions (last 90 days) — for broader context
 */

import { generate } from "@/lib/llm";
import { getSkillsPrompt } from "@/agents/skills";
import { getInsiderTransactions } from "@/lib/finnhub";
import { searchRecentForm4, type Form4Filing } from "@/lib/edgar";
import { insiderSummary, type InsiderRow } from "@/lib/facts/precomputed";

const USER_AGENT = "Finava App liamblackshawbrown@gmail.com";

interface RecentPurchase {
  ticker: string;
  insiderName: string;
  title?: string;
  shares: number;
  price: number;
  totalValue: number;
  isNewPosition: boolean;
  filedAt: string;
  periodOfReport: string;
  /** Date the trade happened, from the filing (not the filing date). */
  transactionDate: string | null;
}

/** Form 4 transaction codes we name explicitly; anything else is "other". */
const CODE_LABELS: Record<string, string> = {
  P: "open-market purchase",
  S: "open-market sale",
  A: "grant or award",
  M: "option exercise",
  F: "shares withheld for tax",
};

interface Form4Transaction {
  code: string;
  acquired: boolean;
  shares: number;
  price: number;
  ownedAfter: number;
  /** Transaction date from the filing. Null when the filing omits it. */
  date: string | null;
  insiderName: string;
  title?: string;
}

const tagValue = (xml: string, tag: string): string | undefined =>
  xml.match(new RegExp(`<${tag}>\\s*<value>([^<]+)</value>`))?.[1]?.trim();

/**
 * Fetch and parse one Form 4 by its accession number.
 *
 * Addressed straight at the filing's own directory listing. The previous version
 * searched browse-edgar for the owner's most recent Form 4 and regex-matched an
 * `.xml` link out of the Atom feed — EDGAR's feed links to the index page, not
 * the XML, so the match failed and no purchase was ever reported.
 */
async function fetchForm4Transactions(
  accessionNo: string,
  cik: string,
  entityName: string
): Promise<Form4Transaction[]> {
  if (!accessionNo || !cik) return [];

  try {
    const bare = accessionNo.replace(/-/g, "");
    const dir = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${bare}`;
    const indexRes = await fetch(`${dir}/index.json`, { headers: { "User-Agent": USER_AGENT } });
    if (!indexRes.ok) return [];
    const index = (await indexRes.json()) as { directory?: { item?: Array<{ name?: string }> } };
    const doc = (index.directory?.item ?? [])
      .map((i) => i.name ?? "")
      // The data file, not EDGAR's rendered xslF345X0*/ wrapper or the index.
      .find((name) => name.endsWith(".xml") && !name.includes("/") && !name.endsWith("-index.xml"));
    if (!doc) return [];

    const xmlRes = await fetch(`${dir}/${doc}`, { headers: { "User-Agent": USER_AGENT } });
    if (!xmlRes.ok) return [];
    const xml = await xmlRes.text();

    const insiderName = xml.match(/<rptOwnerName>([^<]+)<\/rptOwnerName>/)?.[1]?.trim() ?? entityName;
    const title = xml.match(/<officerTitle>([^<]+)<\/officerTitle>/)?.[1]?.trim();

    const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? [];
    return blocks.map((block) => ({
      code: block.match(/<transactionCode>([^<]+)<\/transactionCode>/)?.[1]?.trim() ?? "",
      acquired: tagValue(block, "transactionAcquiredDisposedCode") === "A",
      shares: parseFloat(tagValue(block, "transactionShares") ?? "0"),
      price: parseFloat(tagValue(block, "transactionPricePerShare") ?? "0"),
      ownedAfter: parseFloat(tagValue(block, "sharesOwnedFollowingTransaction") ?? "0"),
      date: tagValue(block, "transactionDate") ?? null,
      insiderName,
      title,
    }));
  } catch {
    return [];
  }
}

export async function runInsiderAgent(input: unknown): Promise<string> {
  const { tickers } = input as { tickers: string[] };

  const sections: string[] = [];

  // ── A. EDGAR Form 4 recent filings ────────────────────────────────────────
  const recentPurchases: RecentPurchase[] = [];
  // Acquisitions that are NOT open-market buys (option exercises, grants, tax
  // withholding). Reported separately so an exercise is never read as conviction.
  const otherActivity = new Map<string, number>();
  // Tickers whose EDGAR lookup itself failed (network/HTTP), as opposed to
  // returning zero filings. We must not report a failed lookup as "no activity."
  const edgarFailed: string[] = [];

  await Promise.allSettled(
    tickers.map(async (ticker) => {
      let filings: Form4Filing[];
      try {
        filings = await searchRecentForm4(ticker, 3, 8);
      } catch {
        edgarFailed.push(ticker);
        return;
      }
      const parsedResults = await Promise.allSettled(
        filings.map(async (f) => ({
          filing: f,
          transactions: await fetchForm4Transactions(f.accessionNo, f.cik, f.entityName),
        }))
      );
      for (const r of parsedResults) {
        if (r.status !== "fulfilled") continue;
        const { filing, transactions } = r.value;
        for (const tx of transactions) {
          if (!tx.shares) continue;
          // An open-market purchase is code P AND an acquisition. Anything else
          // acquired (M, A, F) is activity, not a bought-with-own-money signal.
          if (tx.code !== "P" || !tx.acquired) {
            if (tx.acquired) {
              const label = CODE_LABELS[tx.code] ?? `other (code ${tx.code || "?"})`;
              otherActivity.set(label, (otherActivity.get(label) ?? 0) + 1);
            }
            continue;
          }
          if (!tx.price) continue;
          const totalValue = tx.shares * tx.price;
          if (totalValue < 100_000) continue;
          recentPurchases.push({
            ticker,
            insiderName: tx.insiderName,
            title: tx.title,
            shares: tx.shares,
            price: tx.price,
            totalValue,
            // Shares acquired ≥ 80% of the stake held afterwards.
            isNewPosition: tx.ownedAfter > 0 && tx.shares / tx.ownedAfter >= 0.8,
            filedAt: filing.filedAt,
            periodOfReport: filing.periodOfReport,
            transactionDate: tx.date,
          });
        }
      }
    })
  );

  // Sort by total value descending
  recentPurchases.sort((a, b) => b.totalValue - a.totalValue);

  const otherNote = otherActivity.size
    ? `\n\nAlso filed (acquisitions that are NOT open-market purchases): ${[...otherActivity]
        .map(([label, n]) => `${n} ${label}${n > 1 ? "s" : ""}`)
        .join(", ")}.`
    : "";

  if (recentPurchases.length > 0) {
    const lines = recentPurchases.map((p, i) => {
      const val = p.totalValue >= 1e6
        ? `$${(p.totalValue / 1e6).toFixed(2)}M`
        : `$${Math.round(p.totalValue).toLocaleString()}`;
      const position = p.isNewPosition ? " [NEW POSITION]" : " [ADDITION]";
      const titlePart = p.title ? ` (${p.title})` : "";
      const when = p.transactionDate ? `Transacted: ${p.transactionDate}` : "Transaction date not stated";
      return `${i + 1}. ${p.insiderName}${titlePart} — BOUGHT ${p.shares.toLocaleString()} shares @ $${p.price.toFixed(2)} = ${val}${position}\n   ${when} | Filed: ${p.filedAt} | Period: ${p.periodOfReport}`;
    });
    sections.push(`## RECENT FORM 4 FILINGS — Purchases >$100K (last 3 days)\n\n${lines.join("\n\n")}${otherNote}`);
  } else if (edgarFailed.length === tickers.length) {
    // Every lookup failed — we have NO information, not a "no activity" signal.
    sections.push(
      `## RECENT FORM 4 FILINGS (last 3 days)\n\n⚠️ EDGAR Form 4 lookup was UNAVAILABLE for ${tickers.join(", ")} (the SEC full-text search could not be reached). Recent insider purchase activity is UNKNOWN — do not treat this as an absence of purchases.`
    );
  } else {
    const failNote = edgarFailed.length
      ? ` (Note: the EDGAR lookup failed for ${edgarFailed.join(", ")}, so those are UNKNOWN rather than confirmed-empty.)`
      : "";
    sections.push(
      `## RECENT FORM 4 FILINGS (last 3 days)\n\nNo qualifying insider purchases (>$100K) found for ${tickers.join(", ")} in the last 3 days. This could mean no transactions occurred, or filings are delayed (Form 4 must be filed within 2 business days of transaction).${failNote}${otherNote}`
    );
  }

  // ── B. Finnhub 90-day history ──────────────────────────────────────────────
  const finnhubData: Record<string, object> = {};

  await Promise.allSettled(
    tickers.map(async (ticker) => {
      try {
        const data = await getInsiderTransactions(ticker);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const transactions = (data.data ?? []).slice(0, 20).map((t: any) => ({
          name: t.name,
          change: t.change,
          transactionPrice: t.transactionPrice,
          transactionDate: t.transactionDate,
          transactionCode: t.transactionCode, // P=purchase, S=sale
          share: t.share,
        }));

        // Label the window with the dates the rows actually carry. Calling an
        // undated slice of 20 rows "the last 90 days" is a claim the data does
        // not support; undated rows are excluded from the window and counted.
        const dated = transactions.filter((t: { transactionDate?: string }) => !!t.transactionDate);
        const dates = dated.map((t: { transactionDate: string }) => t.transactionDate).sort();
        const undatedRowsExcluded = transactions.length - dated.length;

        const purchases = dated.filter((t: { transactionCode: string }) => t.transactionCode === "P");
        const sales = dated.filter((t: { transactionCode: string }) => t.transactionCode === "S");
        // Shares × price is done here, once, so no model ever multiplies (W4-1).
        const totals = insiderSummary(transactions as InsiderRow[]);
        const fmt = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v).toLocaleString("en-US")}`);

        finnhubData[ticker] = {
          window: dates.length
            ? { from: dates[0], to: dates[dates.length - 1], transactions: dates.length }
            : "Finnhub returned no transaction dates for this ticker, so the period these rows cover is unknown.",
          undatedRowsExcluded,
          activity: {
            purchases: purchases.length,
            sales: sales.length,
            totalBuyValue: fmt(totals.buys.value),
            totalSellValue: fmt(totals.sells.value),
            ratio:
              sales.length > 0
                ? `${(purchases.length / sales.length).toFixed(1)}x buy/sell`
                : purchases.length > 0
                  ? "All purchases"
                  : "No transactions",
          },
          notable: dated.slice(0, 8).map((t: { change?: number; transactionPrice?: number }) => ({
            ...t,
            value: t.transactionPrice ? fmt(Math.abs(t.change ?? 0) * t.transactionPrice) : "Unavailable",
          })),
        };
      } catch {
        finnhubData[ticker] = { error: "Could not fetch Finnhub insider data" };
      }
    })
  );

  sections.push(
    `## FINNHUB — Insider Transaction History (window stated per ticker)\n\n${JSON.stringify(finnhubData, null, 2)}`
  );

  const combinedData = sections.join("\n\n---\n\n");

  // ── C. LLM synthesis ──────────────────────────────────────────────────────
  return generate({
    agent: "insider",
    system: getSkillsPrompt("insider"),
    maxTokens: 1600,
    prompt: `You are an expert at reading SEC insider trading signals. Analyze the following insider trading data for ${tickers.join(", ")} and provide actionable insights.

${combinedData}

Write a structured analysis covering:
1. **Recent Activity (Form 4)**: Highlight any significant purchases in the last 3 days — who bought, how much, and whether it's a new or existing position. Large purchases from C-suite executives are the most bullish signal.
2. **90-Day Pattern**: Summarize the overall buy/sell ratio trend from Finnhub. Is management net buyers or net sellers?
3. **Signal Quality**: Are these open-market purchases (most bullish) or option exercises? Are executives buying at current market prices?
4. **Conviction Assessment**: Rate insider conviction as HIGH / MODERATE / LOW / NONE for each ticker with reasoning.
5. **Red Flags**: Any concerning patterns (heavy selling, CEO/CFO liquidating positions)?

Be direct and specific with dollar amounts and names. Every dollar value above (each row's "value", totalBuyValue, totalSellValue, and each Form 4 purchase total) is computed in code — quote it exactly. Never multiply shares by price or recompute a total yourself.`,
  });
}
