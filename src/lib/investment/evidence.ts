// Evidence items: what a source actually said, stamped against the run's as-of.
//
// Three properties this module exists to guarantee, each of which is a bug we
// would otherwise ship:
//
//  1. OBSERVED-AT IS NOT PUBLISHED-AT. `observedAt` is when WE read a value and is
//     always known, because we did the reading. `publishedAt` is when the provider
//     says the value is from, and is frequently unknowable. Collapsing them is how
//     look-ahead hides — a figure fetched at 09:15 can be a revision published the
//     day after the decision it is about. The standing vocabulary and the
//     classification rules are Finava Live's (`live/asOf.ts`), reused rather than
//     redefined: two implementations of "is this fact from the future" is how the
//     property rots.
//
//  2. A NUMBER APPEARING SOMEWHERE IS NOT SUPPORT FOR A CLAIM. A 10-K contains
//     thousands of figures; citing the filing does not establish that it said what
//     a claim says it said. So every item declares the input it supplies (`field`)
//     and the financial period it covers, and `coversSubject` refuses evidence
//     whose ticker, field or period does not match the claim's subject. An undated
//     figure never establishes a period-specific claim.
//
//  3. UNITS ARE DECLARED AND NARROW. The enum below has no `percent` and no
//     `usd_millions`, deliberately. Returns in this feature are fractions (0.15 is
//     15%), and a figure a filing reports in millions must be multiplied out before
//     it becomes evidence. Admitting a scaled or percentage unit means arithmetic
//     downstream has to ask which convention each number arrived in, and the day it
//     guesses wrong a 1,450% expected return ships.
//
// Nothing here fabricates. A value we could not read is absent and surfaces as a
// SourceGap (see snapshot.ts) — never a plausible stand-in. See lib/dataAccuracy.ts.

import { createHash } from "node:crypto";
import { z } from "zod";
import { shouldWithhold, stampFact, type FactStamp } from "@/lib/live/asOf";
import {
  EvidenceItemSchema,
  toEvidenceStanding,
  type EvidenceItem,
  type ResearchClaim,
} from "./schemas";

// ── Units ────────────────────────────────────────────────────────────────────

/**
 * The units a figure may arrive in. Base units only.
 *
 * `fraction` is the one proportion unit: 0.15 means 15%. There is no `percent`
 * because two proportion units means every consumer must ask which one it got.
 * There is no `usd_millions` because a filing's "in millions" table must be
 * multiplied out at the adapter, where the scale is still visible, rather than
 * carried as a modifier that a later stage can forget to apply.
 */
export const EvidenceUnitSchema = z.enum([
  "usd",
  "usd_per_share",
  "shares",
  "ratio",
  "fraction",
  "count",
  "days",
]);
export type EvidenceUnit = z.infer<typeof EvidenceUnitSchema>;

export const EvidenceKindSchema = EvidenceItemSchema.shape.kind;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

// ── Validation of the things the frozen contract cannot express ───────────────

/**
 * A ticker as we will compare it. Normalised to upper case first, because a claim
 * about "aapl" citing evidence about "AAPL" is the same subject and a
 * case-sensitive mismatch would reject it for no reason.
 */
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,11}$/;

/**
 * The period forms a figure may declare. Anything else is rejected rather than
 * stored, because period comparison is how `coversSubject` distinguishes an FY2024
 * number from an FY2025 claim — a free-text period ("last year") makes that
 * comparison meaningless while still looking precise.
 */
const PERIOD_FORMS: readonly RegExp[] = [
  /^FY\d{4}$/,
  /^Q[1-4] \d{4}$/,
  /^Q[1-4] FY\d{4}$/,
  /^H[12] \d{4}$/,
  /^TTM \d{4}-\d{2}-\d{2}$/,
  /^\d{4}-\d{2}-\d{2}$/,
];

/**
 * Kinds whose figures are meaningless without a period. A financial line item or
 * a derived ratio with no period cannot support a claim about a year, and a price
 * with no date cannot anchor a return — so the period is required at construction
 * rather than discovered missing during valuation.
 */
const PERIOD_REQUIRED: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  "price",
  "financial",
  "filing",
  "transcript",
  "derived",
]);

/** A field name we can put in a document id and parse back out. */
const FIELD_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;

export function isValidPeriod(period: string): boolean {
  return PERIOD_FORMS.some((re) => re.test(period));
}

// ── Drafts in, evidence out ───────────────────────────────────────────────────

/**
 * What an adapter hands us. `text` is the WHOLE source excerpt it read, which may
 * be megabytes; `EvidenceItem.excerpt` is the short, renderable slice and the full
 * text goes to chunked storage (see snapshot.ts). The snapshot must never carry a
 * whole filing: Firestore rejects any document over 1 MiB, and the rejection
 * discards the entire paid step.
 */
export interface EvidenceDraft {
  ticker: string;
  /** The valuation input this supplies, e.g. "freeCashFlow". Drives coverage. */
  field: string;
  kind: EvidenceKind;
  source: string;
  url?: string | null;
  /** What the provider says the value is from. Null when it will not say. */
  publishedAt?: string | null;
  /** When we read it. Defaults to now, because we are reading it now. */
  observedAt?: string;
  period?: string | null;
  /** The figure, when this item carries one. Null for prose evidence. */
  value?: number | null;
  /** Required whenever `value` is present. A bare number is not a quantity. */
  unit?: EvidenceUnit | null;
  text: string;
}

/**
 * A built item plus the parts the frozen `EvidenceItemSchema` has no room for.
 * `fullText` is what gets chunked; `field`/`value`/`unit` drive coverage and
 * subject matching and are recoverable from the id (see `evidenceFieldOf`).
 */
export interface BuiltEvidence {
  item: EvidenceItem;
  field: string;
  value: number | null;
  unit: EvidenceUnit | null;
  fullText: string;
  stamp: FactStamp;
}

export type EvidenceBuildResult =
  | { ok: true; built: BuiltEvidence }
  | { ok: false; reason: string };

/** How much of a source we render inline. The rest lives in chunked storage. */
export const EXCERPT_CHARS = 1_200;

/**
 * The content fingerprint.
 *
 * Deliberately excludes `observedAt`: two reads of the same filing five minutes
 * apart are the SAME content, and hashing the read clock would make every re-read
 * look like new information. It includes `publishedAt`, `period`, `unit` and
 * `value`, because a figure restated for a different period, or the same number in
 * a different unit, is different content however identical the prose looks.
 */
export function evidenceContentHash(draft: EvidenceDraft): string {
  // A fixed field list joined with NUL rather than canonical JSON: the fields are
  // enumerated here, so there is no nesting to order and nothing to canonicalise —
  // and this module stays free of firebase-admin, which live/ledger.ts (where
  // canonicalJson lives) imports at module load. Same reason ledgerCollections.ts
  // was split out of ledger.ts. NUL is the separator because it cannot occur in any
  // of these fields, so no two different field sets can join to the same string.
  const parts: (string | null)[] = [
    draft.ticker.trim().toUpperCase(),
    draft.field,
    draft.kind,
    draft.source,
    draft.url ?? null,
    draft.publishedAt ?? null,
    draft.period ?? null,
    draft.value === null || draft.value === undefined ? null : String(draft.value),
    draft.unit ?? null,
    draft.text,
  ];
  return createHash("sha256")
    .update(parts.map((p) => (p === null ? "\u0001null" : p)).join("\u0000"))
    .digest("hex");
}

/**
 * The id. Field and kind are encoded in it on purpose: the persisted
 * `EvidenceItem` has nowhere to put the field, and without it a later stage
 * reading a stored snapshot could not tell which valuation input an item supplied.
 * Truncated hash because the id appears in every claim's `evidenceIds` and a full
 * 64 hex characters per citation is pure document weight.
 */
export function evidenceId(field: string, kind: EvidenceKind, contentHash: string): string {
  return `${field}__${kind}__${contentHash.slice(0, 16)}`;
}

/** The field an id was built for, or null when the id was not built by us. */
export function evidenceFieldOf(id: string): string | null {
  const field = id.split("__")[0];
  return field && FIELD_RE.test(field) && id.split("__").length === 3 ? field : null;
}

/**
 * Validate a draft and stamp it against the run's as-of.
 *
 * Returns a reason rather than throwing, so one malformed source cannot abort a
 * snapshot that has already paid for twenty good ones — the caller records it as a
 * gap and carries on with what it has.
 */
export function buildEvidenceItem(
  draft: EvidenceDraft,
  ctx: { asOf: string; now?: () => Date }
): EvidenceBuildResult {
  const ticker = draft.ticker.trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) {
    return { ok: false, reason: `invalid ticker ${JSON.stringify(draft.ticker)}` };
  }
  if (!FIELD_RE.test(draft.field)) {
    return { ok: false, reason: `invalid field ${JSON.stringify(draft.field)}` };
  }
  if (!EvidenceKindSchema.safeParse(draft.kind).success) {
    return { ok: false, reason: `invalid evidence kind ${JSON.stringify(draft.kind)}` };
  }
  if (!draft.source.trim()) {
    return { ok: false, reason: "evidence must name its source" };
  }

  const period = draft.period ?? null;
  if (period !== null && !isValidPeriod(period)) {
    return {
      ok: false,
      reason: `unrecognised period ${JSON.stringify(period)} — expected FY2025, Q2 2026, TTM 2026-06-30 or 2026-06-30`,
    };
  }
  if (period === null && PERIOD_REQUIRED.has(draft.kind)) {
    return {
      ok: false,
      reason: `${draft.kind} evidence must declare the period it covers — an undated figure cannot support a claim about a period`,
    };
  }

  const value = draft.value ?? null;
  const unit = draft.unit ?? null;
  if (value !== null) {
    if (!Number.isFinite(value)) {
      return { ok: false, reason: `value for ${draft.field} is not a finite number` };
    }
    if (unit === null) {
      return {
        ok: false,
        reason: `value for ${draft.field} has no unit — a bare number is not a quantity`,
      };
    }
    if (!EvidenceUnitSchema.safeParse(unit).success) {
      return {
        ok: false,
        reason: `unsupported unit ${JSON.stringify(unit)} for ${draft.field}; convert to a base unit first`,
      };
    }
  } else if (unit !== null) {
    return { ok: false, reason: `unit declared for ${draft.field} with no value` };
  }

  const observedAt = draft.observedAt ?? (ctx.now?.() ?? new Date()).toISOString();
  const stamp = stampFact({
    field: draft.field,
    source: draft.source,
    sourceAsOf: draft.publishedAt ?? null,
    asOf: ctx.asOf,
    observedAt,
  });

  const contentHash = evidenceContentHash({ ...draft, ticker });
  const candidate: EvidenceItem = {
    id: evidenceId(draft.field, draft.kind, contentHash),
    ticker,
    kind: draft.kind,
    source: draft.source,
    url: draft.url ?? null,
    publishedAt: draft.publishedAt ?? null,
    observedAt,
    period,
    contentHash,
    excerpt: draft.text.slice(0, EXCERPT_CHARS),
    standing: toEvidenceStanding(stamp.standing),
  };

  const parsed = EvidenceItemSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: `evidence failed its own contract: ${parsed.error.message}` };
  }

  return {
    ok: true,
    built: { item: parsed.data, field: draft.field, value, unit, fullText: draft.text, stamp },
  };
}

// ── Standing ─────────────────────────────────────────────────────────────────

export interface EvidencePartition {
  /** Safe to show the crew: clean or undated. */
  usable: BuiltEvidence[];
  /** Post-dates the cutoff. Withheld — this is the look-ahead guard. */
  withheld: BuiltEvidence[];
  /** Clean plus undated is not the same as clean. What weakened the record. */
  unverifiable: BuiltEvidence[];
}

/**
 * Split built evidence by standing, using Live's `shouldWithhold`.
 *
 * Only post-as-of evidence is withheld. Undated evidence is kept and flagged,
 * because refusing everything a provider declines to date would empty the bundle
 * and replace a measurable weakness with a silent one — the same trade Live makes
 * and for the same reason.
 */
export function partitionEvidence(built: readonly BuiltEvidence[]): EvidencePartition {
  const usable: BuiltEvidence[] = [];
  const withheld: BuiltEvidence[] = [];
  const unverifiable: BuiltEvidence[] = [];
  for (const b of built) {
    if (shouldWithhold(b.stamp)) withheld.push(b);
    else usable.push(b);
    if (b.stamp.standing !== "clean") unverifiable.push(b);
  }
  return { usable, withheld, unverifiable };
}

// ── Claim support ────────────────────────────────────────────────────────────

/** What a claim is about, declared by the agent rather than guessed from prose. */
export const ClaimSubjectSchema = z.object({
  ticker: z.string().min(1),
  /** Null for a claim about no particular period, e.g. a governance observation. */
  period: z.string().nullable(),
  /** Inputs the claim is about. Empty means "any field of this ticker". */
  fields: z.array(z.string().min(1)),
});
export type ClaimSubject = z.infer<typeof ClaimSubjectSchema>;

/**
 * Does this item actually cover the claim's subject?
 *
 * The period rule is the load-bearing one: an item with a null period does NOT
 * cover a period-specific subject. That is the difference between "the filing
 * mentions debt" and "debt rose in FY2025", and rendering the first as the second
 * is the failure this whole module is built to prevent.
 */
export function coversSubject(item: EvidenceItem, subject: ClaimSubject): boolean {
  if (item.ticker !== subject.ticker.trim().toUpperCase()) return false;
  if (subject.period !== null && item.period !== subject.period) return false;
  if (subject.fields.length > 0) {
    const field = evidenceFieldOf(item.id);
    if (field === null || !subject.fields.includes(field)) return false;
  }
  return true;
}

/**
 * Evidence ids a claim cites that are not in the information set.
 *
 * A model citing an id it invented is the ordinary case, not an exotic one: ids
 * are short strings and an agent under instruction to cite will produce something
 * that looks like one. Returned in first-reference order and deduplicated, so a
 * caller can name them in an error without a second pass.
 */
export function unknownEvidenceIds(
  claims: readonly ResearchClaim[],
  evidence: readonly EvidenceItem[]
): string[] {
  const known = new Set(evidence.map((e) => e.id));
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    for (const id of claim.evidenceIds) {
      if (!known.has(id) && !seen.has(id)) {
        seen.add(id);
        missing.push(id);
      }
    }
  }
  return missing;
}
