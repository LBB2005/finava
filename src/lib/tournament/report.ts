import {
  binaryTargetReport,
  MIN_SAMPLES_TO_REPORT,
  missingnessReport,
  independenceDiagnostics,
} from "../investment/evaluation/metrics";
import {
  DETERMINISTIC_ARMS,
  HORIZONS,
  type TournamentRow,
  type TournamentGrade,
  type PaperSnapshot,
  type Namespace,
} from "./types";
import type { ResolvedPrediction } from "../investment/evaluation/outcomes";
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export function neweyWest(xs: number[], lag: number) {
  const n = xs.length,
    m = mean(xs);
  let tStatistic: number | null = null;
  if (n >= MIN_SAMPLES_TO_REPORT && n > lag + 1 && m !== null) {
    const u = xs.map((x) => x - m);
    let variance = u.reduce((s, x) => s + x * x, 0) / n;
    for (let k = 1; k <= lag; k++) {
      let covariance = 0;
      for (let i = k; i < n; i++) covariance += u[i] * u[i - k];
      variance += (2 * (1 - k / (lag + 1)) * covariance) / n;
    }
    const se = Math.sqrt(Math.max(0, variance) / n);
    if (se > 0) tStatistic = m / se;
  }
  return {
    observations: n,
    lag,
    mean: n >= MIN_SAMPLES_TO_REPORT ? m : null,
    tStatistic,
    note: "Descriptive Bartlett/Newey-West statistic on complete daily long-book cohorts. Overlapping horizons and shared factors remain; no p-value or significance claim.",
  };
}
export function buildReport(
  rows: TournamentRow[],
  grades: TournamentGrade[],
  portfolios: PaperSnapshot[],
  namespace: Namespace,
) {
  const byId = new Map(grades.map((g) => [g.predictionId, g]));
  const versionKey = (r: TournamentRow) =>
    `${r.strategyVersion}:${r.registrationHash}:${r.prediction.versions.targetDefinitions}:${r.prediction.provenance.basis}`;
  const cohorts = [...DETERMINISTIC_ARMS, "ensemble", "jev"].flatMap((arm) =>
    HORIZONS.flatMap((horizon) => {
      const candidates = rows.filter(
        (r) => r.arm === arm && r.prediction.horizonCount === horizon,
      );
      const versions = [...new Set(candidates.map(versionKey))];
      if (!versions.length) versions.push("no_observations");
      return versions.map((cohortVersion) => {
        const cohort = candidates.filter(
          (r) => versionKey(r) === cohortVersion,
        );
        const resolved = cohort
          .map((r) => byId.get(r.id)?.result)
          .filter(
            (r): r is { status: "resolved"; outcome: ResolvedPrediction } =>
              r?.status === "resolved",
          )
          .map((r) => r.outcome);
        const forecastedIds = new Set(
          cohort
            .filter((r) => ["long", "avoid", "neutral"].includes(r.disposition))
            .map((r) => r.id),
        );
        const excess = resolved
          .filter((r) => forecastedIds.has(r.predictionId))
          .flatMap((r) => (r.excessReturn == null ? [] : [r.excessReturn]));
        const decile = (d: number) =>
          cohort
            .filter((r) => r.decile === d)
            .flatMap((r) => {
              const g = byId.get(r.id)?.result;
              return g?.status === "resolved" && g.outcome.excessReturn !== null
                ? [g.outcome.excessReturn]
                : [];
            });
        const top = decile(10),
          bottom = decile(1);
        const longs = cohort.filter((r) => r.disposition === "long"),
          days = [...new Set(longs.map((r) => r.date))].sort();
        const daily = days.flatMap((day) => {
          const subset = longs.filter((r) => r.date === day);
          const values = subset
            .map((r) => byId.get(r.id)?.result)
            .flatMap((r) =>
              r?.status === "resolved" && r.outcome.excessReturn !== null
                ? [r.outcome.excessReturn]
                : [],
            );
          return values.length === subset.length && values.length
            ? [mean(values)!]
            : [];
        });
        const binary = binaryTargetReport(resolved, "outperformBenchmark");
        return {
          arm,
          horizon,
          cohortVersion,
          count: cohort.length,
          graded: cohort.filter((r) => byId.has(r.id)).length,
          unresolved: cohort.filter(
            (r) =>
              byId.has(r.id) && byId.get(r.id)!.result.status === "unresolved",
          ).length,
          returnSamples: excess.length,
          status:
            excess.length >= MIN_SAMPLES_TO_REPORT ? "ok" : "insufficient data",
          hitRate:
            excess.length >= MIN_SAMPLES_TO_REPORT
              ? mean(excess.map((x) => (x > 0 ? 1 : 0)))
              : null,
          meanExcessReturn:
            excess.length >= MIN_SAMPLES_TO_REPORT ? mean(excess) : null,
          decileSpread:
            top.length >= MIN_SAMPLES_TO_REPORT &&
            bottom.length >= MIN_SAMPLES_TO_REPORT
              ? mean(top)! - mean(bottom)!
              : null,
          calibration: {
            outperform: binary,
            positive: binaryTargetReport(resolved, "positiveTotalReturn"),
          },
          missingness: missingnessReport(
            resolved,
            cohort.flatMap((r) => {
              const g = byId.get(r.id)?.result;
              return g?.status === "unresolved"
                ? [{ predictionId: r.id, reason: g.reason }]
                : [];
            }),
          ),
          independence: independenceDiagnostics(
            resolved.map((r) => ({
              issuer: r.ticker,
              windowStart: cohort
                .find((c) => c.id === r.predictionId)!
                .prediction.evaluationWindow!.entryAt.slice(0, 10),
              windowEnd: r.effectiveWindowEnd,
            })),
          ),
          primary: neweyWest(daily, horizon - 1),
          excludedLongDays: days.length - daily.length,
          dispositions: Object.fromEntries(
            [...new Set(cohort.map((r) => r.disposition))].map((d) => [
              d,
              cohort.filter((r) => r.disposition === d).length,
            ]),
          ),
        };
      });
    }),
  );
  const leaderboard = cohorts
    .filter((c) => c.horizon === 20)
    .map((c) => ({
      arm: c.arm,
      cohortVersion: c.cohortVersion,
      primaryMean: c.primary.mean,
      tStatistic: c.primary.tStatistic,
      dailyObservations: c.primary.observations,
      brier: c.calibration.outperform.brier,
      status:
        c.primary.mean === null ? "insufficient data" : "descriptive only",
    }))
    .sort(
      (a, b) =>
        (b.primaryMean ?? -Infinity) - (a.primaryMean ?? -Infinity) ||
        a.arm.localeCompare(b.arm),
    );
  return {
    namespace,
    calibrationEligible: namespace === "tournament",
    warning:
      namespace === "tournament_dryrun"
        ? "DRY RUN: pipeline evidence only. Synthetic/hindsight fixtures must never enter calibration."
        : "Prospective observations; no automatic calibration promotion. Missingness is part of the result.",
    leaderboard,
    cohorts,
    portfolios: portfolios.map(
      ({ date, arm, nav, costUsd, holdingsKnown, reasons }) => ({
        date,
        arm,
        nav,
        costUsd,
        holdingsKnown,
        reasons,
      }),
    ),
    nonResolution: grades
      .filter((g) => g.result.status === "unresolved")
      .map((g) => ({ predictionId: g.predictionId, result: g.result })),
  };
}
export function reportMarkdown(report: ReturnType<typeof buildReport>) {
  const fmt = (x: number | null, percent = false) =>
    x === null
      ? "insufficient data"
      : percent
        ? `${(100 * x).toFixed(2)}%`
        : x.toFixed(4);
  return [
    `# Finava prediction tournament`,
    "",
    report.warning,
    "",
    "Calibration is shown beside the pre-registered 20-session return ordering. A low sample count does not constitute a track record.",
    "",
    "| Arm | 20-session mean excess | HAC t | Daily cohorts | Beat-SPY Brier |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...report.leaderboard.map(
      (r) =>
        `| ${r.arm} | ${fmt(r.primaryMean, true)} | ${fmt(r.tStatistic)} | ${r.dailyObservations} | ${fmt(r.brier)} |`,
    ),
    "",
    `Predictions: ${report.cohorts.reduce((n, c) => n + c.count, 0)}. Grades: ${report.cohorts.reduce((n, c) => n + c.graded, 0)}. Top-level unresolved: ${report.nonResolution.length}.`,
    "",
    "Full JSON includes each horizon, reliability bins (minimum bin count 10), overlap diagnostics, missingness, dispositions and paper NAV. Minimum displayed metric sample count: 30. No p-values. No model confidence is treated as investment probability.",
    "",
  ].join("\n");
}
