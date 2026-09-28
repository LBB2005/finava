import { isMatured } from "../investment/evaluation/predictions";
import {
  resolvePrediction,
  type TotalReturnData,
  NON_RESOLUTION,
} from "../investment/evaluation/outcomes";
import { hashEntry } from "../live/ledgerHash";
import { CHAIN_GENESIS } from "../live/ledgerCollections";
import { verifyLedger } from "./runtime";
import type { TournamentLedger, TournamentRow } from "./types";
export type ReturnProvider = (row: TournamentRow) => Promise<TotalReturnData>;
export async function gradeMatured(
  ledger: TournamentLedger,
  provider: ReturnProvider,
  now: Date,
) {
  const batches = await verifyLedger(ledger),
    grades = await ledger.grades(),
    existing = new Set(grades.map((g) => g.id));
  let graded = 0;
  for (const batch of batches)
    for (const row of await ledger.rows(batch.date)) {
      const id = `${row.id}_${row.prediction.horizonCount}`;
      if (existing.has(id) || !isMatured(row.prediction, now)) continue;
      let data: TotalReturnData | null = null;
      let failure: string | null = null;
      try {
        data = await provider(row);
      } catch (error) {
        failure =
          error instanceof Error ? error.message : "Market data unavailable";
      }
      const result = data
        ? resolvePrediction(row.prediction, data, { now })
        : {
            status: "unresolved" as const,
            reason: NON_RESOLUTION.malformedData,
            detail: failure!,
          };
      await ledger.appendGrade({
        id,
        predictionId: row.id,
        horizon: row.prediction.horizonCount,
        gradedAt: now.toISOString(),
        result,
        dataHash: hashEntry(data ?? { failure }, CHAIN_GENESIS),
        entryOpen: data?.subject.startPrice ?? null,
        spyEntryOpen: data?.benchmark?.startPrice ?? null,
      });
      existing.add(id);
      graded++;
    }
  return { graded };
}
