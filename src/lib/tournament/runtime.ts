import { canonicalJson, hashEntry } from "../live/ledgerHash";
import { CHAIN_GENESIS } from "../live/ledgerCollections";
import { makeBatch, verifyBatches } from "../live/ledgerTournament";
import { cleanInputs, emptyInputs } from "../facts/pointInTime";
import { sessionWindow, type MarketSession } from "../marketCalendar";
import type { ReservationStore } from "../live/budgetReservation";
import { withTournamentBudget, TournamentBudgetError } from "./modelTransport";
import {
  runJev,
  runEnsemble,
  unavailable,
  type ModelResult,
  type ForecastWindow,
} from "./models";
import { makePrediction, snapshotHash } from "./predictions";
import { rankStrategies, modelShortlist } from "./strategies";
import {
  DETERMINISTIC_ARMS,
  HORIZONS,
  type TournamentSnapshot,
  type TournamentLedger,
  type Namespace,
  type TournamentRow,
  type RankedName,
} from "./types";
export interface Journal {
  get<T>(key: string): Promise<T | null>;
  create(key: string, value: unknown): Promise<void>;
}
export class MemoryJournal implements Journal {
  private data = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.data.get(key) ?? null) as T | null;
  }
  async create(key: string, value: unknown) {
    if (
      this.data.has(key) &&
      canonicalJson(this.data.get(key)) !== canonicalJson(value)
    )
      throw new Error("Checkpoint conflict");
    this.data.set(key, structuredClone(value));
  }
}
export async function verifyLedger(ledger: TournamentLedger) {
  const batches = await ledger.listBatches();
  const chain = verifyBatches(
    await Promise.all(
      batches.map(async (batch) => ({
        batch,
        rows: await ledger.rows(batch.date),
      })),
    ),
  );
  if (!chain.valid) throw new Error(chain.reason!);
  return batches;
}
export function sanitizeSnapshot(s: TournamentSnapshot): TournamentSnapshot {
  if (
    !Number.isFinite(Date.parse(s.asOf)) ||
    !Number.isFinite(Date.parse(s.observedAt)) ||
    Date.parse(s.observedAt) < Date.parse(s.asOf) ||
    s.membership.date !== s.asOf.slice(0, 10) ||
    !s.membership.source
  )
    throw new Error("Dated universe membership is required");
  const symbols = s.membership.members.map((m) => m.ticker);
  if (
    !symbols.length ||
    new Set(symbols).size !== symbols.length ||
    new Set(s.names.map((n) => n.ticker)).size !== s.names.length
  )
    throw new Error("Empty or duplicate universe");
  if (s.names.some((n) => !symbols.includes(n.ticker)))
    throw new Error("Evidence outside dated universe");
  return {
    ...s,
    names: s.membership.members.map((m) => {
      const n = s.names.find((n) => n.ticker === m.ticker) ?? {
        ticker: m.ticker,
        sector: m.sector,
        inputs: emptyInputs(),
        reasons: ["No observation for member"],
      };
      const cleaned = cleanInputs(n.inputs, s.asOf);
      return {
        ...n,
        inputs: cleaned.inputs,
        reasons: [...new Set([...n.reasons, ...cleaned.reasons])],
      };
    }),
  };
}
type Model = (
  arm: "ensemble" | "jev",
  ticker: string,
  evidence: string,
  windows: ForecastWindow[],
  asOf: string,
) => Promise<ModelResult>;
export interface DailyOptions {
  ledger: TournamentLedger;
  journal: Journal;
  reservations: ReservationStore;
  cap: number;
  snapshot: TournamentSnapshot;
  sessions: MarketSession[];
  codeSha: string;
  registrationHash: string;
  namespace: Namespace;
  now?: () => Date;
  model?: Model;
  modelsDisabled?: boolean;
}
export async function runDaily(o: DailyOptions) {
  const now = o.now ?? (() => new Date()),
    date = o.snapshot.asOf.slice(0, 10);
  const batches = await verifyLedger(o.ledger);
  if (batches.some((b) => b.date === date))
    return { status: "duplicate" as const, date };
  const windows = HORIZONS.map((h) => ({
    horizon: h,
    ...sessionWindow(o.sessions, date, h),
  }));
  const assertOpen = () => {
    if (now().getTime() >= Date.parse(windows[0].entryAt))
      throw new Error("No backfill: next entry open has passed");
  };
  assertOpen();
  const session = o.sessions.find((s) => s.date === date);
  if (
    !session ||
    session.close !== o.snapshot.asOf ||
    now().getTime() < Date.parse(session.close)
  )
    throw new Error("Snapshot must match a completed exchange close");
  if (
    !/^[a-f0-9]{40}$/.test(o.codeSha) ||
    !/^[a-f0-9]{64}$/.test(o.registrationHash)
  )
    throw new Error("Commit SHA and registration hash required");
  const current = sanitizeSnapshot(o.snapshot);
  if (o.namespace === "tournament" && current.evidenceClass !== "prospective")
    throw new Error("Synthetic evidence cannot enter the prospective ledger");
  if (Date.parse(current.observedAt) > now().getTime())
    throw new Error("Snapshot observation is in the future");
  const saved = await o.journal.get<TournamentSnapshot>(`${date}_snapshot`);
  const snapshot = saved ?? current;
  if (!saved) await o.journal.create(`${date}_snapshot`, snapshot);
  if (snapshotHash(snapshot) !== snapshotHash(current))
    throw new Error(
      "Snapshot differs from original attempt; resume with archived inputs",
    );
  const metadata = {
    codeSha: o.codeSha,
    registrationHash: o.registrationHash,
    windows,
    namespace: o.namespace,
    snapshotHash: snapshotHash(snapshot),
  };
  const originalMetadata = await o.journal.get(`${date}_metadata`);
  if (
    originalMetadata &&
    canonicalJson(originalMetadata) !== canonicalJson(metadata)
  )
    throw new Error(
      "Resume metadata differs: restore the original code, registration and calendar before continuing",
    );
  if (!originalMetadata) await o.journal.create(`${date}_metadata`, metadata);
  const ranks = rankStrategies(snapshot),
    shortlist = modelShortlist(ranks);
  const selected =
    o.namespace === "tournament_dryrun" ? shortlist.slice(0, 2) : shortlist;
  const model =
    o.model ??
    ((arm, ticker, evidence, w, asOf) =>
      arm === "jev"
        ? runJev(evidence, w)
        : runEnsemble(ticker, evidence, w, asOf));
  const outputs = new Map<string, ModelResult>();
  for (const ticker of selected)
    for (const arm of ["ensemble", "jev"] as const) {
      assertOpen();
      const key = `${date}_${arm}_${ticker}`,
        done = await o.journal.get<ModelResult>(`${key}_result`);
      if (done) {
        outputs.set(`${arm}_${ticker}`, done);
        continue;
      }
      let result: ModelResult;
      if (o.modelsDisabled)
        result = unavailable("Models disabled for offline fixture validation");
      else if (await o.journal.get(`${key}_started`))
        result = unavailable(
          "Interrupted model attempt; not replayed to avoid duplicate spend",
        );
      else {
        await o.journal.create(`${key}_started`, { at: now().toISOString() });
        const subject = snapshot.names.find((n) => n.ticker === ticker)!;
        // Both competitors receive exactly these same bytes, and no cross-arm output.
        const evidence = canonicalJson({
          asOf: snapshot.asOf,
          snapshotHash: snapshotHash(snapshot),
          subject,
          rank: ranks.composite.find((r) => r.ticker === ticker),
          windows,
        });
        try {
          const run = await withTournamentBudget(o.reservations, o.cap, () =>
            model(arm, ticker, evidence, windows, snapshot.asOf),
          );
          result = run.denied
            ? {
                ...unavailable("Daily model budget exhausted"),
                status: "skipped_budget",
              }
            : { ...run.value, costUsd: run.costUsd };
        } catch (error) {
          result =
            error instanceof TournamentBudgetError
              ? { ...unavailable(error.message), status: "skipped_budget" }
              : unavailable(
                  error instanceof Error ? error.message : "Model failed",
                );
        }
      }
      await o.journal.create(`${key}_result`, result);
      outputs.set(`${arm}_${ticker}`, result);
    }
  const rows: TournamentRow[] = [];
  const fingerprints = {
    snapshot: snapshotHash(snapshot),
    membership: hashEntry(snapshot.membership, CHAIN_GENESIS),
  };
  const createdAt =
    (await o.journal.get<string>(`${date}_createdAt`)) ?? now().toISOString();
  await o.journal.create(`${date}_createdAt`, createdAt);
  for (const arm of DETERMINISTIC_ARMS)
    for (const r of ranks[arm])
      for (const w of windows)
        rows.push(
          makePrediction({
            snapshot,
            fingerprints,
            arm,
            ...r,
            horizon: w.horizon,
            window: w,
            codeSha: o.codeSha,
            registrationHash: o.registrationHash,
            createdAt,
          }),
        );
  for (const arm of ["ensemble", "jev"] as const) {
    const scored = selected
      .map((ticker) => ({ ticker, result: outputs.get(`${arm}_${ticker}`)! }))
      .filter(
        (x) =>
          x.result.status === "ok" &&
          x.result.forecasts.find((f) => f.horizon === 20)?.beatSpy != null,
      )
      .sort(
        (a, b) =>
          b.result.forecasts.find((f) => f.horizon === 20)!.beatSpy! -
            a.result.forecasts.find((f) => f.horizon === 20)!.beatSpy! ||
          a.ticker.localeCompare(b.ticker),
      );
    for (const n of snapshot.names) {
      const result = outputs.get(`${arm}_${n.ticker}`),
        index = scored.findIndex((s) => s.ticker === n.ticker),
        size = Math.min(10, Math.floor(scored.length / 2));
      const disposition: RankedName["disposition"] = !result
        ? "not_selected_for_model"
        : result.status !== "ok"
          ? result.status
          : index < 0
            ? "unscored"
            : index < size
              ? "long"
              : index >= scored.length - size
                ? "avoid"
                : "neutral";
      for (const w of windows)
        rows.push(
          makePrediction({
            snapshot,
            fingerprints,
            arm,
            ticker: n.ticker,
            rank: index < 0 ? null : index + 1,
            decile:
              index < 0
                ? null
                : 10 - Math.min(9, Math.floor((index * 10) / scored.length)),
            disposition,
            horizon: w.horizon,
            window: w,
            codeSha: o.codeSha,
            registrationHash: o.registrationHash,
            createdAt,
            forecast: result?.forecasts.find((f) => f.horizon === w.horizon),
            model: result?.model,
            costUsd:
              result?.costUsd == null ? null : result.costUsd / windows.length,
            latencyMs: result?.latencyMs,
            reasons: [
              result?.reason ??
                (index < 0
                  ? "Not selected or no 20-day forecast"
                  : "Model forecasts remain unvalidated"),
            ],
          }),
        );
    }
  }
  assertOpen();
  const batch = makeBatch(rows, batches.at(-1) ?? null, {
    date,
    asOf: snapshot.asOf,
    createdAt,
    codeSha: o.codeSha,
    registrationHash: o.registrationHash,
    snapshotHash: snapshotHash(snapshot),
    namespace: o.namespace,
  });
  const status = await o.ledger.appendBatch(batch, rows);
  return {
    status,
    date,
    rows: rows.length,
    hash: batch.hash,
    inputHash: hashEntry(snapshot, CHAIN_GENESIS),
  };
}
