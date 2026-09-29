import { it, expect, vi } from "vitest";
import { DatedSources, parseSnapshot } from "./sources";
import { fixtureSnapshot, fixtureSessions } from "./fixtures";
import { filterCompanyFacts } from "../facts/pointInTime";
it("excludes restatements published after cutoff before extraction", () => {
  const raw = {
    facts: {
      "us-gaap": {
        Revenues: {
          units: {
            USD: [
              { filed: "2026-07-01", end: "2026-03-31", val: 10 },
              { filed: "2026-07-02", end: "2026-03-31", val: 20 },
              { filed: "2026-08-01", end: "2026-03-31", val: 30 },
            ],
          },
        },
      },
    },
  };
  const filtered = filterCompanyFacts(raw, "2026-07-02T20:00:00Z");
  expect(JSON.stringify(filtered)).toContain('"val":10');
  expect(JSON.stringify(filtered)).not.toContain('"val":20');
  expect(raw.facts["us-gaap"].Revenues.units.USD).toHaveLength(3);
});
it("validates the complete facts contract, fills absent members, strips future input", () => {
  const s = fixtureSnapshot();
  s.names.pop();
  s.names[0].inputs.price.asOf = "2027-01-01";
  const clean = parseSnapshot(s);
  expect(clean.names).toHaveLength(30);
  expect(clean.names[0].inputs.price.value).toBeNull();
  expect(clean.names[29].inputs.price.value).toBeNull();
  const duplicate = fixtureSnapshot();
  duplicate.membership.members.push(duplicate.membership.members[0]);
  expect(() => parseSnapshot(duplicate)).toThrow(/duplicate/);
  expect(() => parseSnapshot({})).toThrow();
});
it("requires verified membership and dated HTTPS artifacts, reuses failed requests without a retry storm", async () => {
  const fn = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("", { status: 429 }));
  const s = new DatedSources({
    url: "https://example.org/evidence",
    fetch: fn,
  });
  await expect(s.snapshot("2026-07-02")).rejects.toThrow(/429/);
  await expect(s.snapshot("2026-07-02")).rejects.toThrow(/429/);
  expect(fn).toHaveBeenCalledTimes(1);
  await expect(s.read("../../env")).rejects.toThrow(/path/);
  await expect(new DatedSources({}).snapshot("2026-07-02")).rejects.toThrow(
    /not configured/,
  );
  const data = fixtureSnapshot();
  data.membership.verified = false;
  data.evidenceClass = "prospective";
  const other = new DatedSources({
    url: "https://example.org",
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(data))),
  });
  await expect(other.snapshot(fixtureSessions()[0].date)).rejects.toThrow(
    /verified/,
  );
});
it("retains missing marks with explicit unknown action coverage", async () => {
  expect(await new DatedSources({}).mark("AAPL", "2026-07-06")).toMatchObject({
    open: null,
    close: null,
    splitFactor: null,
    actionsComplete: false,
  });
});

it("withholds same-day date-only and timezone-less availability timestamps", () => {
  const s = fixtureSnapshot();
  s.names[0].inputs.price.asOf = s.asOf.slice(0, 10);
  s.names[1].inputs.price.asOf = s.asOf.slice(0, -1);
  const clean = parseSnapshot(s);
  expect(clean.names[0].inputs.price.value).toBeNull();
  expect(clean.names[1].inputs.price.value).toBeNull();
});
