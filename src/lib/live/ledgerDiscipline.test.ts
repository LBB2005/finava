import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { LEDGER_COLLECTIONS } from "./ledgerCollections";

// The append-only guarantee is server-side discipline: firestore.rules denies
// all client access, so nothing at the database level stops a future route from
// calling liveDecisions.set() and quietly rewriting history.
//
// This test is that stop. Only the ledger module may name an append-only
// collection; everything else goes through its exported appenders and readers.
// It is deliberately a build failure rather than a code-review convention,
// because the property it protects is the entire basis of the public record.

const SRC = join(process.cwd(), "src");

/** The only modules allowed to name a ledger collection directly. */
const ALLOWED = new Set([
  join("src", "lib", "live", "ledger.ts"),
  join("src", "lib", "live", "ledgerRead.ts"),
  join("src", "lib", "live", "ledgerTournament.ts"),
  join("src", "lib", "live", "ledger.test.ts"),
  join("src", "lib", "live", "ledgerRead.test.ts"),
  join("src", "lib", "live", "ledgerDiscipline.test.ts"),
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("ledger discipline", () => {
  it("keeps every append-only collection behind the ledger module", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = join("src", relative(SRC, file));
      if (ALLOWED.has(rel)) continue;
      const source = readFileSync(file, "utf8");

      for (const collection of [...LEDGER_COLLECTIONS, "tournament", "tournament_dryrun"]) {
        // Matches collection("liveDecisions") / collection('liveDecisions'),
        // which is the only way to reach one of these from the Admin SDK.
        const pattern = new RegExp(`collection\\(\\s*["'\`]${collection}["'\`]`);
        if (pattern.test(source)) {
          offenders.push(`${rel.split(sep).join("/")} → ${collection}`);
        }
      }
      if (/collection\(\s*namespace\s*\)/.test(source)) {
        offenders.push(`${rel.split(sep).join("/")} → dynamic tournament namespace`);
      }
    }

    expect(
      offenders,
      `These modules reach an append-only collection directly. Use the exported ` +
        `appenders in src/lib/live/ledger.ts (or readers in ledgerRead.ts) instead — ` +
        `a direct .set() would silently overwrite a published record:\n  ` +
        offenders.join("\n  ")
    ).toEqual([]);
  });

  it("covers every collection the ledger declares", () => {
    // If someone adds a collection to LEDGER_COLLECTIONS, the sweep above picks
    // it up automatically — this asserts the list is non-empty and well-formed
    // so a typo can't quietly disable the whole check.
    expect(LEDGER_COLLECTIONS.length).toBeGreaterThan(0);
    for (const c of LEDGER_COLLECTIONS) {
      expect(c).toMatch(/^live[A-Z]/);
    }
  });
});
