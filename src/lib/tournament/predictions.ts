import { buildPredictionRecord } from "../investment/evaluation/predictions";
import { promoteProbabilityBasis } from "../investment/evaluation/calibration";
import { hashEntry } from "../live/ledgerHash";
import { CHAIN_GENESIS } from "../live/ledgerCollections";
import type {
  Arm,
  Disposition,
  TournamentRow,
  TournamentSnapshot,
} from "./types";
export const STRATEGY_VERSION = "tournament-v1";
export const TARGET_VERSION = "next-open-total-return-v1";
export const TARGETS = {
  positiveTotalReturn:
    "Split-adjusted exit close plus entitled cash distributions, divided by next-session official entry open, minus one, strictly greater than zero. No dividend reinvestment; gross of costs and taxes.",
  outperformBenchmark:
    "Subject total return minus SPY total return over identical next-open to target-close window is strictly greater than zero; same cash-distribution convention.",
};
export function snapshotHash(s: TournamentSnapshot) {
  return hashEntry(s, CHAIN_GENESIS);
}
export interface ModelForecast {
  horizon: number;
  positive: number | null;
  beatSpy: number | null;
  expectedReturn: number | null;
  reason: string | null;
}
export function makePrediction(p: {
  snapshot: TournamentSnapshot;
  arm: Arm;
  ticker: string;
  rank: number | null;
  decile: number | null;
  disposition: Disposition;
  horizon: number;
  window: { entryAt: string; targetAt: string; targetDate: string };
  codeSha: string;
  registrationHash: string;
  createdAt: string;
  forecast?: ModelForecast;
  model?: string | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  reasons?: string[];
}): TournamentRow {
  const sh = snapshotHash(p.snapshot),
    version = `${STRATEGY_VERSION}:${p.arm}`;
  const available = ["long", "avoid", "neutral"].includes(p.disposition);
  const modeled = p.arm === "jev" || p.arm === "ensemble";
  const forecasts = {
    positiveTotalReturn: available
      ? (p.forecast?.positive ?? (modeled ? null : 0.5))
      : null,
    outperformBenchmark: available
      ? (p.forecast?.beatSpy ?? (modeled ? null : 0.5))
      : null,
    scenarioBucket: null,
    thesisInvalidation: null,
  };
  const reasons = [
    ...(p.reasons ?? []),
    ...(p.forecast?.reason ? [p.forecast.reason] : []),
  ];
  if (!modeled)
    reasons.push(
      "Cold-start decile prior: 0.5 for each binary event; no measured decile base rates yet. Expected return unavailable.",
    );
  const promotion = promoteProbabilityBasis(
    modeled ? "model_unvalidated" : "fixed_prior",
    null,
    { cohort: `${p.horizon}_trading_days`, target: "outperformBenchmark" },
  );
  const built = buildPredictionRecord({
    ownerUid: `tournament:${p.arm}`,
    reportId: null,
    snapshotId: `${sh}:${version}`,
    ticker: p.ticker,
    disposition:
      p.disposition === "long"
        ? "selected"
        : p.disposition === "neutral"
          ? "neutral"
          : "rejected",
    rating:
      p.disposition === "long"
        ? "buy"
        : p.disposition === "avoid"
          ? "avoid"
          : "watch",
    reasonCodes: reasons.length ? reasons : [p.disposition],
    asOf: p.snapshot.asOf,
    targetDate: p.window.targetDate,
    evaluationWindow: {
      entryAt: p.window.entryAt,
      targetAt: p.window.targetAt,
      entryConvention: "next_session_official_open",
      targetDefinitions: TARGETS,
    },
    targetDefinitionsVersion: TARGET_VERSION,
    horizonCount: p.horizon,
    horizonUnit: "trading_days",
    yearFraction:
      (Date.parse(p.window.targetAt) - Date.parse(p.window.entryAt)) /
      86400000 /
      365.25,
    forecasts,
    buckets: null,
    expectedTotalReturn: p.forecast?.expectedReturn ?? null,
    scenarioReturns: null,
    invalidationConditions: [],
    provenance: {
      basis: promotion.basis,
      calibrationVersion: null,
      model: p.model ?? null,
      promptHash: modeled
        ? hashEntry(
            {
              targets: TARGETS,
              arm: p.arm,
              version,
              snapshotHash: sh,
              ticker: p.ticker,
              horizon: p.horizon,
              window: p.window,
            },
            CHAIN_GENESIS,
          )
        : null,
    },
    policyVersion: version,
    valuationVersion: "finava-score-v2",
    agentVersion: version,
    latencyMs: p.latencyMs ?? null,
    costUsd: p.costUsd ?? (modeled ? null : 0),
    createdAt: p.createdAt,
  });
  if (built.status !== "ok") throw new Error(built.reason);
  return {
    id: built.record.id,
    date: p.snapshot.asOf.slice(0, 10),
    arm: p.arm,
    strategyVersion: version,
    codeSha: p.codeSha,
    registrationHash: p.registrationHash,
    snapshotHash: sh,
    membershipHash: hashEntry(p.snapshot.membership, CHAIN_GENESIS),
    prediction: built.record,
    disposition: p.disposition,
    rank: p.rank,
    decile: p.decile,
    reasons,
  };
}
