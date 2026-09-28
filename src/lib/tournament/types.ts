import type { PredictionRecord } from "../investment/evaluation/predictions";
import type { ResolutionResult } from "../investment/evaluation/outcomes";
import type { ScoreInputs } from "../finavaScore";
import type { Fact } from "../facts/types";
import type { Constituent } from "../sp500";
export const HORIZONS = [1, 5, 20, 60, 120] as const;
export const DETERMINISTIC_ARMS = [
  "value",
  "quality",
  "growth",
  "momentum",
  "contrarian",
  "composite",
] as const;
export type DeterministicArm = (typeof DETERMINISTIC_ARMS)[number];
export type Arm = DeterministicArm | "ensemble" | "jev";
export type Namespace = "tournament" | "tournament_dryrun";
export type Disposition =
  | "long"
  | "avoid"
  | "neutral"
  | "unscored"
  | "skipped_budget"
  | "unavailable"
  | "not_selected_for_model";
export type InputFacts = Record<keyof ScoreInputs, Fact<number>>;
export interface TournamentSnapshot {
  evidenceClass: "prospective" | "synthetic";
  asOf: string;
  observedAt: string;
  membership: {
    date: string;
    source: string;
    verified: boolean;
    members: Constituent[];
  };
  names: {
    ticker: string;
    sector: string;
    inputs: InputFacts;
    reasons: string[];
  }[];
}
export interface RankedName {
  ticker: string;
  score: number | null;
  rank: number | null;
  decile: number | null;
  disposition: Disposition;
  reasons: string[];
}
export interface TournamentRow {
  id: string;
  date: string;
  arm: Arm;
  strategyVersion: string;
  codeSha: string;
  registrationHash: string;
  snapshotHash: string;
  membershipHash: string;
  prediction: PredictionRecord;
  disposition: Disposition;
  rank: number | null;
  decile: number | null;
  reasons: string[];
}
export interface TournamentBatch {
  date: string;
  asOf: string;
  createdAt: string;
  codeSha: string;
  registrationHash: string;
  snapshotHash: string;
  namespace: Namespace;
  rowIds: string[];
  previousHash: string;
  hash: string;
  previousDate: string | null;
}
export interface TournamentGrade {
  id: string;
  predictionId: string;
  horizon: number;
  gradedAt: string;
  result: ResolutionResult;
  dataHash: string;
  entryOpen: number | null;
  spyEntryOpen: number | null;
}
export interface PaperPosition {
  ticker: string;
  shares: number;
}
export interface PaperSnapshot {
  id: string;
  date: string;
  arm: Arm | "spy";
  cash: number;
  positions: PaperPosition[];
  nav: number | null;
  costUsd: number | null;
  reasons: string[];
  createdAt: string;
}
export interface TournamentLedger {
  listBatches(): Promise<TournamentBatch[]>;
  rows(date: string): Promise<TournamentRow[]>;
  appendBatch(
    batch: TournamentBatch,
    rows: TournamentRow[],
  ): Promise<"created" | "duplicate">;
  grades(): Promise<TournamentGrade[]>;
  appendGrade(grade: TournamentGrade): Promise<void>;
  portfolios(): Promise<PaperSnapshot[]>;
  appendPortfolio(snapshot: PaperSnapshot): Promise<void>;
}
