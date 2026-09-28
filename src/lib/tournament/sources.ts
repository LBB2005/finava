// Strict ingestion boundary. Existing UI facts have period dates, but do not
// certify filing-publication cutoffs or historical index membership. Do not
// silently relabel them as a point-in-time archive.
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TotalReturnDataSchema,
  type TotalReturnData,
} from "../investment/evaluation/outcomes";
import { INPUT_KEYS } from "../facts/pointInTime";
import { sanitizeSnapshot } from "./runtime";
import type { TournamentSnapshot, TournamentRow } from "./types";
import type { DayMark } from "./portfolio";
import { validDate } from "../marketCalendar";
const FactSchema = z.object({
  value: z.number().finite().nullable(),
  asOf: z.string(),
  source: z.string().min(1),
  note: z.string().optional(),
  url: z.string().optional(),
  period: z.string().optional(),
  unit: z.string().optional(),
});
const SnapshotSchema = z.object({
  evidenceClass: z.enum(["prospective", "synthetic"]),
  asOf: z.iso.datetime(),
  observedAt: z.iso.datetime(),
  membership: z.object({
    date: z.string().refine(validDate),
    source: z.string().min(1),
    verified: z.boolean(),
    members: z
      .array(
        z.object({
          ticker: z.string().regex(/^[A-Z0-9.-]+$/),
          name: z.string(),
          sector: z.string(),
        }),
      )
      .min(1),
  }),
  names: z.array(
    z.object({
      ticker: z.string(),
      sector: z.string(),
      inputs: z
        .record(z.string(), FactSchema)
        .refine(
          (x) => INPUT_KEYS.every((k) => k in x),
          "Every score field must be present, including missing values",
        ),
      reasons: z.array(z.string()),
    }),
  ),
});
export function parseSnapshot(raw: unknown): TournamentSnapshot {
  return sanitizeSnapshot(SnapshotSchema.parse(raw) as TournamentSnapshot);
}
export interface SourceConfig {
  directory?: string;
  url?: string;
  fetch?: typeof fetch;
}
export class DatedSources {
  private cache = new Map<string, Promise<unknown>>();
  constructor(
    private config: SourceConfig = {
      directory: process.env.TOURNAMENT_DATA_DIR,
      url: process.env.TOURNAMENT_DATA_URL,
    },
  ) {}
  async read(name: string): Promise<unknown> {
    if (!/^[a-z]+\/\d{4}-\d{2}-\d{2}\.json$/.test(name))
      throw new Error("Invalid evidence artifact path");
    const existing = this.cache.get(name);
    if (existing) return existing;
    const read = async () => {
      if (this.config.directory)
        return JSON.parse(
          await readFile(join(this.config.directory, name), "utf8"),
        );
      if (this.config.url) {
        const base = new URL(this.config.url);
        if (base.protocol !== "https:" || base.username || base.password)
          throw new Error(
            "Evidence URL must be HTTPS without inline credentials",
          );
        const url = new URL(name, `${base.href.replace(/\/$/, "")}/`);
        const response = await (this.config.fetch ?? fetch)(url, {
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok)
          throw new Error(
            `Dated evidence unavailable (${response.status}); no retries`,
          );
        return response.json();
      }
      throw new Error(
        "Verified dated data source is not configured. Set TOURNAMENT_DATA_DIR or TOURNAMENT_DATA_URL; current UI facts are not a point-in-time archive.",
      );
    };
    const promise = read();
    this.cache.set(name, promise);
    return promise;
  }
  async snapshot(date: string) {
    const result = parseSnapshot(await this.read(`snapshots/${date}.json`));
    if (result.asOf.slice(0, 10) !== date)
      throw new Error("Snapshot date mismatch");
    if (result.evidenceClass !== "prospective")
      throw new Error("Synthetic evidence cannot enter a live source archive");
    if (!result.membership.verified)
      throw new Error(
        "Universe membership must be verified before live scoring",
      );
    return result;
  }
  async returns(row: TournamentRow): Promise<TotalReturnData> {
    const window = row.prediction.evaluationWindow!;
    const raw = z
      .object({
        source: z.string().min(1),
        coverageConfirmed: z.literal(true),
        records: z.record(z.string(), TotalReturnDataSchema),
      })
      .parse(await this.read(`returns/${row.prediction.targetDate}.json`));
    const key = `${row.prediction.ticker}_${window.entryAt.slice(0, 10)}_${row.prediction.targetDate}`;
    const result = raw.records[key];
    if (!result)
      throw new Error(
        "Total-return observation absent; keep prediction unresolved",
      );
    return result;
  }
  async mark(ticker: string, date: string): Promise<DayMark> {
    try {
      const raw = z
        .object({
          source: z.string().min(1),
          records: z.record(
            z.string(),
            z.object({
              open: z.number().positive().nullable(),
              close: z.number().positive().nullable(),
              splitFactor: z.number().positive().nullable(),
              cashPerPreviousShare: z.number().nonnegative().nullable(),
              actionsComplete: z.boolean(),
              termination: z
                .object({
                  at: z.enum(["before_open", "after_open"]),
                  cashPerPreviousShare: z.number().nonnegative().nullable(),
                  successor: z
                    .object({
                      ticker: z.string().regex(/^[A-Z0-9.-]+$/),
                      sharesPerPreviousShare: z.number().nonnegative(),
                    })
                    .nullable(),
                })
                .nullable()
                .optional(),
              reason: z.string().nullable(),
            }),
          ),
        })
        .parse(await this.read(`marks/${date}.json`));
      return (
        raw.records[ticker] ?? {
          open: null,
          close: null,
          splitFactor: null,
          cashPerPreviousShare: null,
          actionsComplete: false,
          reason: "No issuer market observation",
        }
      );
    } catch {
      return {
        open: null,
        close: null,
        splitFactor: null,
        cashPerPreviousShare: null,
        actionsComplete: false,
        reason: "Dated market evidence unavailable",
      };
    }
  }
}
