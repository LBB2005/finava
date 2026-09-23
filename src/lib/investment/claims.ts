// Raw agent output in, strict claims out.
//
// This is the gate between a language model's prose and a document a reader will
// treat as research. Four rules, in the order they matter:
//
//  1. OBSERVED IS NOT INFERENCE IS NOT ASSUMPTION. `kind` is required on every
//     claim because an inference rendered with the visual authority of a reported
//     fact is the single most misleading thing this system could produce. "Revenue
//     grew 12% in FY2025" and "revenue will keep growing at 12%" look identical in
//     a bullet list and differ in everything that matters. An `observed` claim with
//     no evidence behind it is rejected outright: that is an inference wearing a
//     fact's clothes.
//
//  2. EVERY CITATION IS CHECKED AGAINST THE SNAPSHOT. Models cite ids that do not
//     exist — not rarely, and not obviously. A claim whose evidence is absent, or
//     whose evidence is about a different ticker or period, is rejected and the
//     rejection is recorded. See evidence.ts `coversSubject`: a number appearing
//     somewhere in a filing is not support for a specific claim.
//
//  3. ONE REPAIR ATTEMPT, THEN THE AGENT IS UNAVAILABLE. Malformed output gets
//     exactly one re-ask. Retrying until something parses spends money to
//     manufacture the appearance of a working agent, and salvaging the claims that
//     happened to parse is worse still — the half that survives is not a random
//     half, and dropping an agent's bear points while keeping its bull points
//     silently tilts the report. An unavailable agent is a publishable outcome.
//
//  4. DISAGREEMENT IS RETAINED. When two agents address the SAME declared subject
//     in opposite directions, both claims are kept and the conflict is recorded in
//     `dissent`. Averaging or dropping one produces a report more confident than
//     its inputs.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ResearchSnapshot } from "./contracts";
import {
  ClaimKindSchema,
  ResearchClaimSchema,
  type ResearchClaim,
} from "./schemas";
import { ClaimSubjectSchema, coversSubject, type ClaimSubject } from "./evidence";

/** Exactly one. Named so the bound is a constant a reader can find, not a literal. */
export const MAX_REPAIR_ATTEMPTS = 1;

// ── The shape we ask an agent for ────────────────────────────────────────────

export const RawClaimSchema = z.object({
  text: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
  kind: ClaimKindSchema,
  direction: ResearchClaimSchema.shape.direction,
  /**
   * What the claim is about, so its citations can be checked against it. Optional
   * because not every claim is about a period or a named input — but a claim
   * without one gets its citations checked only for existence and ticker, which is
   * a weaker guarantee and is why the prompt should always ask for it.
   */
  subject: ClaimSubjectSchema.nullish(),
});
export type RawClaim = z.infer<typeof RawClaimSchema>;

/**
 * Either a bare array or `{ claims: [...] }`.
 *
 * Tolerating the wrapper is a tolerance of SHAPE, not of content: models wrap
 * arrays in an object about half the time and rejecting that would burn a repair
 * attempt on a formatting habit. Nothing below this line is lenient.
 */
export const RawClaimBatchSchema = z.union([
  z.array(RawClaimSchema),
  z.object({ claims: z.array(RawClaimSchema) }),
]);

function claimsOf(parsed: z.infer<typeof RawClaimBatchSchema>): RawClaim[] {
  return Array.isArray(parsed) ? parsed : parsed.claims;
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

// ── Parsing, with one repair ─────────────────────────────────────────────────

export interface AgentOutput {
  agent: string;
  /** Whatever the model returned, already JSON-parsed. Unknown on purpose. */
  raw: unknown;
}

/** Asked once, with the errors, to return the same content in the right shape. */
export type SchemaRepair = (input: {
  agent: string;
  raw: unknown;
  errors: string[];
}) => Promise<unknown>;

export type AgentParse =
  | { status: "ok"; agent: string; claims: RawClaim[]; repaired: boolean }
  | { status: "unavailable"; agent: string; errors: string[]; repaired: boolean };

/**
 * Parse one agent's output, repairing at most once.
 *
 * A repair that throws counts as a used attempt and the agent is unavailable: a
 * transport failure during repair is not a reason to start a second repair loop.
 */
export async function parseAgentClaims(
  output: AgentOutput,
  deps: { repair?: SchemaRepair } = {}
): Promise<AgentParse> {
  const first = RawClaimBatchSchema.safeParse(output.raw);
  if (first.success) {
    return { status: "ok", agent: output.agent, claims: claimsOf(first.data), repaired: false };
  }

  const errors = issuesOf(first.error);
  if (!deps.repair) {
    return { status: "unavailable", agent: output.agent, errors, repaired: false };
  }

  let repairedRaw: unknown;
  try {
    repairedRaw = await deps.repair({ agent: output.agent, raw: output.raw, errors });
  } catch (err) {
    return {
      status: "unavailable",
      agent: output.agent,
      errors: [...errors, `repair threw: ${err instanceof Error ? err.message : String(err)}`],
      repaired: true,
    };
  }

  const second = RawClaimBatchSchema.safeParse(repairedRaw);
  if (second.success) {
    return { status: "ok", agent: output.agent, claims: claimsOf(second.data), repaired: true };
  }
  // No partial salvage. The claims that parsed are not a representative half.
  return {
    status: "unavailable",
    agent: output.agent,
    errors: [...errors, ...issuesOf(second.error).map((e) => `after repair: ${e}`)],
    repaired: true,
  };
}

// ── Admission ────────────────────────────────────────────────────────────────

export interface RejectedClaim {
  agent: string;
  text: string;
  reason: string;
}

export type ClaimAdmission =
  | { ok: true; claim: ResearchClaim; subject: ClaimSubject | null }
  | { ok: false; rejected: RejectedClaim };

/**
 * Content-derived id, so re-running the same agent output yields the same claim
 * ids and a retried stage does not duplicate the report's findings. The agent is
 * part of the hash: two agents reaching the same conclusion independently is signal
 * and must stay two claims.
 */
export function claimId(
  agent: string,
  kind: RawClaim["kind"],
  direction: RawClaim["direction"],
  text: string,
  evidenceIds: readonly string[]
): string {
  const hash = createHash("sha256")
    .update([agent, kind, direction, text, [...evidenceIds].sort().join(",")].join("\u0000"))
    .digest("hex");
  return `claim_${hash.slice(0, 16)}`;
}

/**
 * Admit one raw claim against the frozen snapshot, or reject it with a reason.
 *
 * The rejection reasons are deliberately specific: "cites evidence e7 which is not
 * in this snapshot" is actionable, "invalid claim" teaches nobody anything and
 * makes a prompt regression invisible.
 */
export function admitClaim(
  agent: string,
  raw: RawClaim,
  snapshot: ResearchSnapshot
): ClaimAdmission {
  const reject = (reason: string): ClaimAdmission => ({
    ok: false,
    rejected: { agent, text: raw.text, reason },
  });

  const subject: ClaimSubject | null = raw.subject ?? null;
  if (subject && subject.ticker.trim().toUpperCase() !== snapshot.ticker) {
    return reject(
      `claim subject is ${subject.ticker.trim().toUpperCase()} but this snapshot is ${snapshot.ticker}`
    );
  }

  if (raw.evidenceIds.length === 0 && raw.kind !== "assumption") {
    return reject(
      `a ${raw.kind} claim must cite at least one piece of evidence; only an assumption may stand alone`
    );
  }

  const byId = new Map(snapshot.evidence.map((e) => [e.id, e]));
  const missing = raw.evidenceIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return reject(`cites evidence not in this snapshot: ${missing.join(", ")}`);
  }

  for (const id of raw.evidenceIds) {
    const item = byId.get(id)!;
    if (item.ticker !== snapshot.ticker) {
      return reject(`cites ${id}, which is evidence about ${item.ticker}, not ${snapshot.ticker}`);
    }
    // Defensive: buildResearchSnapshot withholds post-as-of evidence, so this can
    // only fire on a snapshot assembled elsewhere. It stays because look-ahead
    // reaching the claim layer would be undetectable from the rendered report.
    if (item.standing === "post_asof") {
      return reject(`cites ${id}, which post-dates the run as-of ${snapshot.asOf}`);
    }
    if (subject && !coversSubject(item, subject)) {
      return reject(
        `cites ${id}, which does not cover the claim's subject (${subject.fields.join("/") || "any field"}, ${subject.period ?? "no period"}) — a figure elsewhere in a source is not support for this claim`
      );
    }
  }

  const candidate = {
    id: claimId(agent, raw.kind, raw.direction, raw.text, raw.evidenceIds),
    agent,
    ticker: snapshot.ticker,
    text: raw.text,
    evidenceIds: raw.evidenceIds,
    kind: raw.kind,
    direction: raw.direction,
  };
  const parsed = ResearchClaimSchema.safeParse(candidate);
  if (!parsed.success) {
    return reject(`failed the claim contract: ${issuesOf(parsed.error).join("; ")}`);
  }
  return { ok: true, claim: parsed.data, subject };
}

// ── Dissent ──────────────────────────────────────────────────────────────────

/**
 * The subject two claims must share before we call them a disagreement.
 *
 * Only claims with a declared subject AND at least one named field qualify. A bull
 * point about margins and a bear point about litigation are not a disagreement, and
 * recording them as one buries the real ones under noise.
 */
function subjectKey(subject: ClaimSubject): string | null {
  if (subject.fields.length === 0) return null;
  return `${subject.ticker.trim().toUpperCase()}|${subject.period ?? "*"}|${[...subject.fields].sort().join(",")}`;
}

/**
 * Record every unresolved opposition, keeping both sides.
 *
 * Nothing here removes or reweights a claim. The report carries the conflict, and a
 * reader sees that the crew did not agree — which is information, not a defect.
 */
export function retainDissent(
  admitted: readonly { claim: ResearchClaim; subject: ClaimSubject | null }[]
): string[] {
  const groups = new Map<string, { claim: ResearchClaim }[]>();
  for (const entry of admitted) {
    if (!entry.subject) continue;
    const key = subjectKey(entry.subject);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push({ claim: entry.claim });
    groups.set(key, group);
  }

  const dissent: string[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const bulls = group.filter((g) => g.claim.direction === "bull");
    const bears = group.filter((g) => g.claim.direction === "bear");
    if (bulls.length === 0 || bears.length === 0) continue;
    for (const bull of bulls) {
      for (const bear of bears) {
        dissent.push(
          `${key}: ${bull.claim.agent} (${bull.claim.kind}, bull) "${bull.claim.text}" vs ${bear.claim.agent} (${bear.claim.kind}, bear) "${bear.claim.text}"`
        );
      }
    }
  }
  return dissent;
}

// ── The stage ────────────────────────────────────────────────────────────────

export interface ResearchClaimSet {
  claims: ResearchClaim[];
  rejected: RejectedClaim[];
  /** Unresolved oppositions over a shared subject. Kept, never smoothed away. */
  dissent: string[];
  /** Agents whose output could not be made to parse. A publishable outcome. */
  unavailableAgents: { agent: string; errors: string[] }[];
}

/**
 * The claim stage of a research run: parse each agent, admit what checks out,
 * record what did not, and keep the disagreements.
 *
 * Takes agent output as an argument rather than calling any agent, so the whole
 * stage is deterministic and testable without a model or a network.
 */
export async function collectResearchClaims(params: {
  snapshot: ResearchSnapshot;
  outputs: readonly AgentOutput[];
  repair?: SchemaRepair;
}): Promise<ResearchClaimSet> {
  const claims: ResearchClaim[] = [];
  const rejected: RejectedClaim[] = [];
  const unavailableAgents: { agent: string; errors: string[] }[] = [];
  const admitted: { claim: ResearchClaim; subject: ClaimSubject | null }[] = [];
  const seen = new Set<string>();

  for (const output of params.outputs) {
    const parse = await parseAgentClaims(output, { repair: params.repair });
    if (parse.status === "unavailable") {
      unavailableAgents.push({ agent: parse.agent, errors: parse.errors });
      continue;
    }

    for (const raw of parse.claims) {
      const admission = admitClaim(parse.agent, raw, params.snapshot);
      if (!admission.ok) {
        rejected.push(admission.rejected);
        continue;
      }
      // One agent repeating itself verbatim is one claim; the id is content-derived
      // so the duplicate is detectable rather than rendered twice.
      if (seen.has(admission.claim.id)) continue;
      seen.add(admission.claim.id);
      claims.push(admission.claim);
      admitted.push({ claim: admission.claim, subject: admission.subject });
    }
  }

  return { claims, rejected, dissent: retainDissent(admitted), unavailableAgents };
}
