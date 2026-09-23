// The real collectors: where the stages meet actual providers. Server-only.
//
// `stages.ts` takes evidence collection, claim extraction and valuation-input
// assembly as injected functions. This module supplies them from the facts layer,
// which already owns provider fan-out, timeouts, caching and per-field
// provenance — so nothing here re-fetches a quote or re-parses a filing.
//
// Three things this module is careful about:
//
//  1. A FACT WITHOUT A VALUE IS A GAP, NOT A ZERO. `Fact<T>` keeps its source even
//     when the value is missing, which is exactly the distinction the report needs:
//     "Finnhub was asked and had nothing" is a gap with a source, whereas a 0
//     would be a number the reader would act on.
//
//  2. AN OUTAGE IS NOT AN ABSENCE. `TickerFacts.dropped` lists sources that failed
//     or timed out THIS read. Those become `unavailable` gaps; a source that
//     answered and simply had no value becomes `not_covered`. Collapsing the two
//     is how a provider failure turns into a statement about the company.
//
//  3. THE PRICE IS RECORDED, NOT RE-READ. `valuationRequest` returns the price it
//     used alongside the request, and `stages.ts` pins it onto the valuation. A
//     later stage re-reading the quote would measure returns from a different
//     price than the scenarios were built on.

import { getTickerFacts } from "@/lib/facts/ticker";
import type { TickerFacts } from "@/lib/facts/types";
import type { Fact } from "@/lib/facts/types";
import { generate } from "@/lib/llm";
import type { EvidenceDraft, EvidenceUnit } from "./evidence";
import type { CollectContext, CollectedSources } from "./snapshot";
import { outageGap, notCoveredGap } from "./snapshot";
import type { AgentOutput } from "./claims";
import type { StageCollectors } from "./stages";
import type { ResearchSnapshot, SourceGap } from "./contracts";
import type { RawValuationInputs } from "./valuationInputs";
import type { ValuationRequest } from "./valuation";

/**
 * The facts this feature reads, mapped to the valuation input each supplies.
 *
 * `field` is what `coverage` and `REQUIRED_INPUTS` are keyed on, so this table is
 * the join between the facts layer's vocabulary and the valuation's.
 */
/**
 * Identifies the default assumption set on every scenario it produces.
 *
 * Versioned so a report built on these defaults is distinguishable from one whose
 * assumptions a user set — and so changing the defaults does not make old reports
 * look like they used the new ones.
 */
export const DEFAULT_ASSUMPTIONS_REF = "default-forward-multiple-v1";

const FACT_FIELDS: ReadonlyArray<{
  key: keyof TickerFacts;
  field: string;
  unit: EvidenceUnit;
  kind: EvidenceDraft["kind"];
  label: string;
}> = [
  { key: "price", field: "currentPrice", unit: "usd_per_share", kind: "price", label: "share price" },
  { key: "sharesOut", field: "dilutedSharesOutstanding", unit: "shares", kind: "financial", label: "shares outstanding" },
  { key: "netIncomeTTM", field: "netIncomeToCommon", unit: "usd", kind: "financial", label: "trailing net income" },
  { key: "fcfTTM", field: "baseCashFlow", unit: "usd", kind: "financial", label: "trailing free cash flow" },
  { key: "debt", field: "totalDebt", unit: "usd", kind: "financial", label: "total debt" },
  { key: "cashAndSTI", field: "cash", unit: "usd", kind: "financial", label: "cash and short-term investments" },
  { key: "beta", field: "beta", unit: "ratio", kind: "derived", label: "beta" },
  { key: "dividendYield", field: "dividendYield", unit: "fraction", kind: "financial", label: "dividend yield" },
];

function factOf(facts: TickerFacts, key: keyof TickerFacts): Fact<unknown> | null {
  const value = facts[key];
  return value && typeof value === "object" && "value" in value ? (value as Fact<unknown>) : null;
}

function numberValue(f: Fact<unknown> | null): number | null {
  return typeof f?.value === "number" && Number.isFinite(f.value) ? f.value : null;
}

/**
 * Turn a facts read into dated evidence drafts plus honest gaps.
 *
 * Exported separately from the collector so it can be tested without a provider.
 */
export function draftsFromFacts(
  facts: TickerFacts,
  asOf: string
): { drafts: EvidenceDraft[]; gaps: SourceGap[] } {
  const drafts: EvidenceDraft[] = [];
  const gaps: SourceGap[] = [];
  const dropped = new Set(facts.dropped.map((d) => d.toLowerCase()));

  for (const spec of FACT_FIELDS) {
    const f = factOf(facts, spec.key);
    if (!f) {
      gaps.push(notCoveredGap("facts", spec.field, `${spec.label} is not part of this read`));
      continue;
    }

    const value = numberValue(f);
    if (value == null) {
      // A source that failed is a different fact about the world from a source
      // that answered and had nothing. `dropped` is what tells them apart.
      const detail = f.note ?? `${spec.label} was unavailable`;
      gaps.push(
        dropped.has(f.source.toLowerCase())
          ? outageGap(f.source, spec.field, detail)
          : notCoveredGap(f.source, spec.field, detail)
      );
      continue;
    }

    drafts.push({
      ticker: facts.ticker,
      field: spec.field,
      kind: spec.kind,
      source: f.source,
      url: f.url ?? null,
      // The provider's own as-of, kept separate from when we read it so
      // `standingOf` can catch a figure published after the run's cutoff.
      publishedAt: f.asOf ?? null,
      observedAt: asOf,
      period: f.period ?? null,
      value,
      unit: spec.unit,
      text: `${spec.label}: ${value}`,
    });
  }

  // Any dropped source with no field of its own still belongs in the record.
  for (const source of facts.dropped) {
    if (!gaps.some((g) => g.source.toLowerCase() === source.toLowerCase())) {
      gaps.push(outageGap(source, "read", `${source} failed or timed out this read`));
    }
  }

  return { drafts, gaps };
}

export interface FactsCollectorDeps {
  /** Injected so tests need no provider. */
  readFacts?: (ticker: string) => Promise<TickerFacts>;
}

/** Evidence collection from the facts layer. */
export function factsCollector(deps: FactsCollectorDeps = {}) {
  const readFacts = deps.readFacts ?? ((ticker: string) => getTickerFacts(ticker));

  return async (ctx: CollectContext): Promise<CollectedSources> => {
    try {
      const facts = await readFacts(ctx.ticker);
      return draftsFromFacts(facts, ctx.asOf);
    } catch (err) {
      // A total failure is one gap, not an exception: the run stays honest and
      // the report says the evidence could not be gathered.
      return {
        drafts: [],
        gaps: [outageGap("facts", "all", err instanceof Error ? err.message : String(err))],
      };
    }
  };
}

/**
 * Assemble a forward-multiple valuation request from a facts read.
 *
 * Forward multiple is the method chosen here because it is the one this data can
 * actually support: trailing net income, share count, price and the dividend are
 * all present, whereas a defensible DCF needs capex quality and a debt figure the
 * facts layer does not always have. Returning null is a real outcome — the
 * valuation stage turns it into a named gap rather than a number.
 */
export function factsValuationRequest(deps: FactsCollectorDeps = {}) {
  const readFacts = deps.readFacts ?? ((ticker: string) => getTickerFacts(ticker));

  return async (
    snapshot: ResearchSnapshot
  ): Promise<{ request: ValuationRequest; priceAtAsOf: number | null } | null> => {
    let facts: TickerFacts;
    try {
      facts = await readFacts(snapshot.ticker);
    } catch {
      return null;
    }

    const price = numberValue(factOf(facts, "price"));
    const shares = numberValue(factOf(facts, "sharesOut"));
    const netIncome = numberValue(factOf(facts, "netIncomeTTM"));
    const yieldFraction = numberValue(factOf(facts, "dividendYield"));

    // Without price, shares or earnings there is no forward multiple to compute.
    // The stage reports the gap; we do not substitute anything.
    if (price == null || shares == null || netIncome == null) return null;

    // A known yield of zero is a measurement (the company pays nothing); an
    // unavailable yield is unknown and must stay null so coverage reflects it.
    const distributionsPerShareAnnual =
      yieldFraction == null ? null : yieldFraction * price;

    const raw: RawValuationInputs = {
      method: "forward_multiple",
      netIncomeToCommon: netIncome,
      dilutedSharesOutstanding: shares,
      currentPrice: price,
      distributionsPerShareAnnual,
      businessType: "operating",
    } as RawValuationInputs;

    // Three scenarios differing only in declared assumptions.
    //
    // These are PRODUCT DEFAULTS, not measurements — the same status as
    // POLICY_V1's thresholds. `annualDilutionRate` is stated explicitly on each
    // because the validator refuses a default: a constant share count quietly
    // credits shareholders with all of a growing company's earnings while it is
    // issuing equity to fund that growth.
    //
    // `assumptionsRef` points at the set so any number in the report can be
    // traced back to the story that produced it.
    const assumptions: ValuationRequest["assumptions"] = [
      {
        method: "forward_multiple",
        scenarioId: "bear",
        assumptionsRef: `${DEFAULT_ASSUMPTIONS_REF}:bear`,
        evidenceIds: [],
        earningsGrowthAnnual: 0,
        annualDilutionRate: 0.01,
        exitMultiple: 12,
      },
      {
        method: "forward_multiple",
        scenarioId: "base",
        assumptionsRef: `${DEFAULT_ASSUMPTIONS_REF}:base`,
        evidenceIds: [],
        earningsGrowthAnnual: 0.06,
        annualDilutionRate: 0.01,
        exitMultiple: 16,
      },
      {
        method: "forward_multiple",
        scenarioId: "bull",
        assumptionsRef: `${DEFAULT_ASSUMPTIONS_REF}:bull`,
        evidenceIds: [],
        earningsGrowthAnnual: 0.12,
        annualDilutionRate: 0,
        exitMultiple: 20,
      },
    ];

    return {
      request: { raw, assumptions, horizon: snapshot.mandate.horizon },
      priceAtAsOf: price,
    };
  };
}

/**
 * Claim extraction.
 *
 * The specialists are asked for STRUCTURED claims against the frozen snapshot,
 * not prose, so `claims.ts` can check every citation against evidence that
 * actually exists. Output is returned RAW — parsing, repair and admission are
 * that module's job, because a collector that pre-parsed could smuggle through a
 * claim citing evidence the snapshot does not contain.
 */
/**
 * The specialists to ask, keyed by their REAL `AgentKey` so the existing model
 * routing, pricing and provider failover apply unchanged. Inventing a new key
 * here would silently bypass all three.
 */
const RESEARCH_AGENTS = ["fundamentals", "risk", "analyst"] as const;

export function llmResearchCollector(
  deps: { agents?: readonly (typeof RESEARCH_AGENTS)[number][] } = {}
) {
  const agents = deps.agents ?? RESEARCH_AGENTS;

  return async (snapshot: ResearchSnapshot, signal: AbortSignal) => {
    const evidenceList = snapshot.evidence
      .map((e) => `- ${e.id} · ${e.source}${e.period ? ` · ${e.period}` : ""} · ${e.excerpt}`)
      .join("\n");

    const outputs: AgentOutput[] = [];
    const gaps: string[] = [];
    let credits = 0;

    for (const agent of agents) {
      if (signal.aborted) {
        gaps.push(`claim extraction was cancelled before ${agent} ran`);
        break;
      }
      try {
        const raw = await generate({
          agent,
          maxTokens: 1500,
          prompt: `You are Finava's ${agent} specialist. Using ONLY the evidence below, state your findings about ${snapshot.ticker} as JSON.

Evidence (cite by id):
${evidenceList || "(no evidence was available)"}

Rules:
- Cite evidence ids that appear above. Never invent an id.
- "observed" = the evidence says it. "inference" = you concluded it from the evidence. "assumption" = neither.
- observed and inference REQUIRE at least one evidenceId. Only assumption may have none.
- If the evidence supports no finding, return {"claims": []}. Do not pad.

Output ONLY:
{ "claims": [ { "text": "<one sentence>", "evidenceIds": ["<id>"], "kind": "observed"|"inference"|"assumption", "direction": "bull"|"bear"|"neutral", "subject": { "ticker": "${snapshot.ticker}", "field": "<evidence field>", "period": "<period or null>" } } ] }`,
        });
        outputs.push({ agent, raw });
      } catch (err) {
        // One specialist failing is a gap, not a dead run.
        gaps.push(`${agent} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // The model router does not return a per-call price here, so cost is reported
    // as unmeasured rather than estimated — an estimate would be
    // indistinguishable from a measurement once it reached costUsd.
    if (outputs.length > 0) {
      gaps.push("the cost of claim extraction was not measured");
      credits = 0;
    }

    return { outputs, credits, gaps };
  };
}

/** The production collector bundle. */
export function productionCollectors(
  deps: FactsCollectorDeps & { db?: StageCollectors["db"]; assess?: StageCollectors["assess"] } = {}
): StageCollectors {
  return {
    collect: factsCollector(deps),
    // Explicitly nullable: skipping chunked source storage is a decision, and
    // passing null here means the snapshot keeps ids and short excerpts only.
    db: deps.db ?? null,
    research: llmResearchCollector(),
    valuationRequest: factsValuationRequest(deps),
    assess: deps.assess,
  };
}
