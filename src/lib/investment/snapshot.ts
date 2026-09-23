// The frozen information set a report is produced from.
//
// A snapshot is taken BEFORE any analyst judgment and never revised. If a filing
// lands an hour later, that is a NEW snapshot and a new report; the old report
// keeps saying what it said on the evidence it had. Silently revising an
// information set under a published conclusion destroys the only thing that makes
// the conclusion checkable — and it is the easy mistake, because "refresh the data"
// feels like an improvement.
//
// Four disciplines, each of which is a bug prevented:
//
//  1. ONE AS-OF PER RUN. Established once here via `establishAsOf` and read by
//     every later stage. Left to itself each stage calls `new Date()`, "when" becomes
//     whenever each fetch happened to land, and the run cannot be replayed against
//     the information set that produced it. See live/asOf.ts.
//
//  2. AN OUTAGE IS NOT A FINDING. `rate_limited` and `unavailable` mean a provider
//     failed us; `not_covered` means the source genuinely has nothing. Collapsing
//     them turns a 429 into an investment verdict — the company looks as though it
//     has no free cash flow when in truth we could not read it. The reason enum in
//     contracts.ts exists for this, and `isOutage` is the predicate the decision
//     stage uses to refuse to rate rather than rate badly.
//
//  3. THE SNAPSHOT NEVER CARRIES A WHOLE FILING. Firestore rejects any document
//     over 1 MiB and discards the write — on 2026-09-02 a 1,051,317-byte run
//     document threw away an eleven-minute paid step (live/transcripts.ts). Source
//     text goes to chunked documents by exactly that module's pattern, at
//     `CHUNK_CHARS` characters per chunk with zero-padded ids so lexicographic
//     order is chunk order past chunk 9. The snapshot carries ids and short
//     excerpts.
//
//  4. THE HASH IS THE INFORMATION SET. Canonical, order-independent, so two runs
//     over the same sources hash the same however the adapters happened to return
//     them. That is what makes DecisionCacheKey's `snapshotHash` mean anything.
//
// The Firestore handle is injected (`SnapshotDb`) so tests use a fake and this
// module stays runnable without credentials.

import { createHash } from "node:crypto";
import { establishAsOf } from "@/lib/live/asOf";
import { canonicalJson } from "@/lib/live/ledger";
import { CHUNK_CHARS, chunkText } from "@/lib/live/transcripts";
import {
  ResearchSnapshotSchema,
  type ResearchMandate,
  type ResearchSnapshot,
  type SourceGap,
} from "./contracts";
import type { EvidenceItem, ValuationMethod } from "./schemas";
import {
  buildEvidenceItem,
  evidenceFieldOf,
  partitionEvidence,
  type BuiltEvidence,
  type EvidenceDraft,
} from "./evidence";
import {
  callTranscriptDraft,
  callTranscriptGap,
  type CallTranscriptProvider,
} from "./callTranscripts";

// ── Chunked source storage ───────────────────────────────────────────────────

/** Parent documents: one per (snapshot, evidence) pair, holding only metadata. */
export const SNAPSHOT_SOURCES = "investmentSnapshotSources";

/**
 * The chunk subcollection, named specifically rather than "chunks" for the reason
 * ledgerCollections.ts records: firestore.indexes.json carries a single-field
 * index exemption per COLLECTION GROUP, and a generic name would apply that
 * exemption to every "chunks" subcollection in the database. Without the exemption
 * a long excerpt eventually exceeds the index-entry size limit and the write is
 * rejected.
 */
export const SOURCE_CHUNKS = "investmentSourceChunks";

/** Zero-padded so lexicographic document-id order IS chunk order past chunk 9. */
function chunkDocId(n: number): string {
  return String(n).padStart(4, "0");
}

/** One document per stored source. "__" because evidence ids already contain ":". */
export function sourceDocId(snapshotId: string, evidenceId: string): string {
  return `${snapshotId}__${evidenceId}`;
}

// The narrowest Firestore surface this module needs. Injected rather than imported
// so a test can pass a fake and so nothing here requires credentials at import
// time; the server passes firebase-admin's `db`.
export interface SourceChunkDoc {
  id: string;
  get(field: string): unknown;
}
export interface SnapshotDocRef {
  set(data: Record<string, unknown>): unknown;
  get(): Promise<{ exists: boolean }>;
  collection(name: string): SnapshotCollectionRef;
}
export interface SnapshotCollectionRef {
  doc(id: string): SnapshotDocRef;
  get(): Promise<{ docs: SourceChunkDoc[] }>;
}
export interface SnapshotBatch {
  set(ref: SnapshotDocRef, data: Record<string, unknown>): unknown;
  delete(ref: SnapshotDocRef): unknown;
  commit(): Promise<unknown>;
}
export interface SnapshotDb {
  collection(name: string): SnapshotCollectionRef;
  batch(): SnapshotBatch;
}

export interface SourceExcerptMeta {
  snapshotId: string;
  evidenceId: string;
  chunks: number;
  chars: number;
  createdAt: string;
}

/**
 * Store one source's full text, replacing anything already at that id.
 *
 * Overwrites rather than appends because a re-run produces a new read of the same
 * source, and a half-replaced excerpt would be worse than either version. Stale
 * chunks past the new length are deleted AFTER the new ones land, so a crash
 * between the two leaves too much rather than too little.
 */
export async function writeSourceExcerpt(
  db: SnapshotDb,
  snapshotId: string,
  evidenceId: string,
  text: string,
  opts: { now?: () => Date; size?: number } = {}
): Promise<SourceExcerptMeta> {
  const now = opts.now ?? (() => new Date());
  // `size` is injectable for tests only. Production always uses CHUNK_CHARS, which
  // live/transcripts.ts sized against the 1 MiB document ceiling.
  const chunks = chunkText(text, opts.size ?? CHUNK_CHARS);
  const doc = db.collection(SNAPSHOT_SOURCES).doc(sourceDocId(snapshotId, evidenceId));
  const meta: SourceExcerptMeta = {
    snapshotId,
    evidenceId,
    chunks: chunks.length,
    chars: text.length,
    createdAt: now().toISOString(),
  };

  const batch = db.batch();
  batch.set(doc, { ...meta });
  chunks.forEach((chunk, n) => {
    batch.set(doc.collection(SOURCE_CHUNKS).doc(chunkDocId(n)), { n, text: chunk });
  });
  await batch.commit();

  const existing = await doc.collection(SOURCE_CHUNKS).get();
  const stale = existing.docs.filter((d) => Number(d.get("n")) >= chunks.length);
  if (stale.length > 0) {
    const cleanup = db.batch();
    for (const d of stale) {
      cleanup.delete(doc.collection(SOURCE_CHUNKS).doc(d.id));
    }
    await cleanup.commit();
  }

  return meta;
}

/** Reassemble a stored source, or null when nothing was stored for it. */
export async function readSourceExcerpt(
  db: SnapshotDb,
  snapshotId: string,
  evidenceId: string
): Promise<string | null> {
  const doc = db.collection(SNAPSHOT_SOURCES).doc(sourceDocId(snapshotId, evidenceId));
  const meta = await doc.get();
  if (!meta.exists) return null;

  const chunks = await doc.collection(SOURCE_CHUNKS).get();
  return chunks.docs
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => String(d.get("text") ?? ""))
    .join("");
}

// ── Coverage ─────────────────────────────────────────────────────────────────

/**
 * The inputs each valuation method needs, by evidence `field`.
 *
 * Enumerated rather than inferred so coverage is a fraction of a FIXED
 * denominator: a method whose inputs we never even asked for would otherwise
 * report 100% coverage of the two things we happened to fetch. decision.ts gates
 * on these numbers, so an inflated one is a rating nothing supports.
 */
export const REQUIRED_INPUTS: Readonly<Record<ValuationMethod, readonly string[]>> = {
  forward_multiple: ["price", "sharesOutstanding", "forwardEps", "peerMultiple"],
  fcff_dcf: [
    "price",
    "sharesOutstanding",
    "freeCashFlow",
    "capex",
    "revenueGrowth",
    "taxRate",
    "netDebt",
    "discountRate",
    "terminalGrowth",
  ],
  fcfe_dcf: [
    "price",
    "sharesOutstanding",
    "netIncome",
    "equityFreeCashFlow",
    "costOfEquity",
    "terminalGrowth",
  ],
  historical_range: ["price", "priceHistory", "historicalMultiple"],
};

/** Four decimals: enough to distinguish any realistic denominator, short to read. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Coverage per method, counting only fields backed by USABLE evidence.
 *
 * Withheld (post-as-of) evidence is excluded on purpose: a figure we refuse to
 * show the crew cannot also be counted as something the crew had.
 */
export function computeCoverage(fields: Iterable<string>): Record<string, number> {
  const present = new Set(fields);
  const coverage: Record<string, number> = {};
  for (const [method, required] of Object.entries(REQUIRED_INPUTS)) {
    const hit = required.filter((f) => present.has(f)).length;
    coverage[method] = required.length === 0 ? 0 : round4(hit / required.length);
  }
  return coverage;
}

// ── Gaps ─────────────────────────────────────────────────────────────────────

/** Provider failed. A retry might succeed, and nothing about the company follows. */
export function outageGap(
  source: string,
  field: string,
  detail: string,
  reason: Extract<SourceGap["reason"], "unavailable" | "rate_limited" | "unauthorized"> = "unavailable"
): SourceGap {
  return { source, field, reason, detail };
}

/** The source genuinely has nothing. A retry changes nothing. */
export function notCoveredGap(source: string, field: string, detail: string): SourceGap {
  return { source, field, reason: "not_covered", detail };
}

/**
 * Was this gap our failure rather than the company's absence?
 *
 * The decision stage must treat an outage as a reason to withhold a rating, and a
 * genuine absence as information. `stale` counts as an outage: data too old to use
 * is data we failed to refresh.
 */
export function isOutage(gap: SourceGap): boolean {
  return gap.reason !== "not_covered";
}

function gapKey(gap: SourceGap): string {
  return `${gap.source}|${gap.field}|${gap.reason}|${gap.detail}`;
}

function dedupeGaps(gaps: readonly SourceGap[]): SourceGap[] {
  const seen = new Map<string, SourceGap>();
  for (const gap of gaps) {
    const key = gapKey(gap);
    if (!seen.has(key)) seen.set(key, gap);
  }
  // Sorted so two runs that recorded the same failures in a different order
  // produce the same bytes, and therefore the same contentHash.
  return [...seen.values()].sort((a, b) => gapKey(a).localeCompare(gapKey(b)));
}

// ── The content hash ─────────────────────────────────────────────────────────

/**
 * The canonical fingerprint of an information set.
 *
 * Order-independent (evidence sorted by id, gaps sorted by key) and deliberately
 * BLIND to `observedAt`, `asOf`, `createdAt` and `ownerUid`. Two users who fetched
 * the same filings hold the same information set even though they read them at
 * different moments, and hashing the read clock would make every run a fresh hash
 * and every cache a miss. The clock is still recorded on the snapshot; it is just
 * not part of what "same information" means. Evidence `standing` IS included,
 * because a figure that was withheld as post-as-of in one run and clean in another
 * is not the same information set.
 */
export function snapshotContentHash(input: {
  ticker: string;
  mandate: ResearchMandate;
  evidence: readonly EvidenceItem[];
  gaps: readonly SourceGap[];
  coverage: Record<string, number>;
}): string {
  const evidence = input.evidence
    .map((e) => ({
      id: e.id,
      ticker: e.ticker,
      kind: e.kind,
      source: e.source,
      url: e.url,
      publishedAt: e.publishedAt,
      period: e.period,
      contentHash: e.contentHash,
      standing: e.standing,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return createHash("sha256")
    .update(
      canonicalJson({
        ticker: input.ticker.trim().toUpperCase(),
        mandate: input.mandate,
        evidence,
        gaps: dedupeGaps(input.gaps),
        coverage: input.coverage,
      })
    )
    .digest("hex");
}

/** ISO instant with the separators stripped, so it is safe in a document id. */
function compactInstant(iso: string): string {
  return iso.replace(/[-:.]/g, "");
}

// ── Freezing ─────────────────────────────────────────────────────────────────

/**
 * Deep-freeze the returned snapshot.
 *
 * "Frozen before any analyst judgment" is a claim about time, but the cheapest way
 * to keep it true is to make the object refuse mutation: a later stage that pushes
 * one more evidence item onto the array it was handed would change the information
 * set out from under the hash that describes it, and nothing would report the
 * discrepancy. It throws in strict mode instead.
 */
export function freezeSnapshot(snapshot: ResearchSnapshot): ResearchSnapshot {
  for (const item of snapshot.evidence) Object.freeze(item);
  for (const gap of snapshot.gaps) Object.freeze(gap);
  Object.freeze(snapshot.evidence);
  Object.freeze(snapshot.gaps);
  Object.freeze(snapshot.coverage);
  Object.freeze(snapshot.mandate);
  return Object.freeze(snapshot);
}

// ── Building ─────────────────────────────────────────────────────────────────

export interface CollectContext {
  ticker: string;
  /** The single cutoff. Adapters must not mint their own. */
  asOf: string;
  mandate: ResearchMandate;
}

/** What a source adapter returns: drafts it read, and what it could not read. */
export interface CollectedSources {
  drafts: EvidenceDraft[];
  gaps: SourceGap[];
}

export interface SnapshotDeps {
  ownerUid: string;
  /** Injected source collection. Takes the run's as-of; never establishes one. */
  collect: (ctx: CollectContext) => Promise<CollectedSources>;
  /**
   * Firestore handle for chunked source storage, or null to skip persisting full
   * source text. Explicitly nullable so skipping is a decision, not an omission.
   */
  db: SnapshotDb | null;
  transcripts?: CallTranscriptProvider;
  /** Fiscal periods to seek call transcripts for, e.g. ["Q2 2026"]. */
  callPeriods?: readonly string[];
  /** Supplied by a replayed run so the same instant is reused, not re-minted. */
  asOf?: string;
  now?: () => Date;
}

/**
 * Take the snapshot.
 *
 * Order matters: the as-of is established first, every later timestamp is
 * classified against it, and the hash is computed last over what survived. A draft
 * that fails validation and a transcript that could not be fetched both become
 * gaps rather than exceptions, so one bad source cannot discard a run that has
 * already paid for twenty good ones.
 */
export async function buildResearchSnapshot(
  mandate: ResearchMandate,
  ticker: string,
  deps: SnapshotDeps
): Promise<ResearchSnapshot> {
  const now = deps.now ?? (() => new Date());
  // ONE as-of for the whole run. A replay passes the stored instant back in so it
  // is reused rather than re-minted — the reproducibility property depends on it.
  const asOf = deps.asOf ?? establishAsOf(now());
  const normalizedTicker = ticker.trim().toUpperCase();

  const collected = await deps.collect({ ticker: normalizedTicker, asOf, mandate });
  const drafts: EvidenceDraft[] = [...collected.drafts];
  const gaps: SourceGap[] = [...collected.gaps];

  // Earnings calls. With no licensed provider configured this contributes only
  // gaps, which is the honest outcome — see callTranscripts.ts.
  if (deps.transcripts && deps.callPeriods?.length) {
    for (const period of deps.callPeriods) {
      const request = { ticker: normalizedTicker, period };
      try {
        const lookup = await deps.transcripts.fetchCall(request);
        if (lookup.status === "available") {
          drafts.push(callTranscriptDraft(lookup.transcript));
        } else {
          const gap = callTranscriptGap(deps.transcripts, request, lookup);
          if (gap) gaps.push(gap);
        }
      } catch (err) {
        // A provider that threw is an OUTAGE, not an absence of coverage. Recording
        // it as not_covered would read as "this company holds no calls".
        gaps.push(
          outageGap(
            deps.transcripts.name,
            `earningsCallTranscript:${period}`,
            `transcript provider threw: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    }
  }

  const built: BuiltEvidence[] = [];
  const byId = new Map<string, BuiltEvidence>();
  for (const draft of drafts) {
    const result = buildEvidenceItem(draft, { asOf, now });
    if (!result.ok) {
      gaps.push(
        outageGap(draft.source, draft.field, `evidence rejected: ${result.reason}`)
      );
      continue;
    }
    // Two adapters reading the same figure produce the same id. Keeping both would
    // double-count it toward coverage without adding information.
    if (byId.has(result.built.item.id)) continue;
    byId.set(result.built.item.id, result.built);
    built.push(result.built);
  }

  const { usable, withheld } = partitionEvidence(built);
  for (const b of withheld) {
    // Not "stale" — the opposite. This figure is from AFTER the cutoff, and using
    // it would let the report know something it could not have known.
    gaps.push(
      outageGap(
        b.item.source,
        b.field,
        `published ${b.item.publishedAt ?? "unknown"}, after the run as-of ${asOf}; withheld to prevent look-ahead`
      )
    );
  }

  const coverage = computeCoverage(
    usable.map((b) => evidenceFieldOf(b.item.id) ?? b.field)
  );
  const evidence = usable
    .map((b) => b.item)
    .sort((a, b) => a.id.localeCompare(b.id));
  const finalGaps = dedupeGaps(gaps);

  const contentHash = snapshotContentHash({
    ticker: normalizedTicker,
    mandate,
    evidence,
    gaps: finalGaps,
    coverage,
  });
  const id = `snap_${normalizedTicker}_${compactInstant(asOf)}_${contentHash.slice(0, 12)}`;

  if (deps.db) {
    // Full source text, out of the snapshot document and under the 1 MiB ceiling.
    for (const b of usable) {
      if (b.fullText.length === 0) continue;
      await writeSourceExcerpt(deps.db, id, b.item.id, b.fullText, { now });
    }
  }

  const snapshot = ResearchSnapshotSchema.parse({
    id,
    ownerUid: deps.ownerUid,
    ticker: normalizedTicker,
    asOf,
    mandate,
    evidence,
    gaps: finalGaps,
    coverage,
    contentHash,
    createdAt: now().toISOString(),
  });

  return freezeSnapshot(snapshot);
}
