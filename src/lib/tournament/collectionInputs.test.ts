import { expect, it } from "vitest";
import { parseMembershipRevision, inputsFromSec, attachMarketInputs, attachPeerInputs } from "./collectionInputs";
import { emptyInputs } from "../facts/pointInTime";

const asOf = "2026-02-02T21:00:00.000Z";
const revision = (timestamp = "2026-01-31T12:00:00Z", added = "2020-01-01") => ({query:{pages:{"1":{revisions:[{revid:123,timestamp,slots:{main:{"*":`id="constituents"
|-
|| {{NasdaqSymbol|AAPL}}
|| [[Apple Inc.]]
|| Information Technology
|| Hardware
|| California
|| ${added}
|| 0000320193
|| 1976
|}`}}}]}}}});
it("uses the dated revision and retains its public source identity", () => {
  const result = parseMembershipRevision(revision(), asOf);
  expect(result.members[0]).toEqual({ticker:"AAPL",name:"Apple Inc.",sector:"Information Technology",cik:"0000320193"});
  expect(result.source).toContain("oldid=123");
});
it("refuses a revision or effective addition after the scoring cutoff", () => {
  expect(() => parseMembershipRevision(revision("2026-02-03T00:00:00Z"), asOf)).toThrow();
  expect(() => parseMembershipRevision(revision(undefined,"2026-02-03"), asOf)).toThrow();
});
it("parses valid mixed wiki cell delimiters without dropping constituents", () => {
  const input=revision();
  input.query.pages["1"].revisions[0].slots.main["*"]=input.query.pages["1"].revisions[0].slots.main["*"]
    .replace("|| {{NasdaqSymbol|AAPL}}", "| {{NasdaqSymbol|AAPL}}")
    .replace("[[Apple Inc.]]\n|| Information", "[[Apple Inc.]]|| Information")
    .replace("|| 1976", "| 1976");
  expect(parseMembershipRevision(input,asOf).members[0]).toMatchObject({ticker:"AAPL",sector:"Information Technology",cik:"0000320193"});
});
function sec() {
  const observations = (prior: number, current: number) => [2024,2025].flatMap(year => [
    ["01-01","03-31"],["04-01","06-30"],["07-01","09-30"],["10-01","12-31"],
  ].map(([start,end]) => ({start:`${year}-${start}`,end:`${year}-${end}`,val:year===2024?prior:current,form:"10-Q",filed:year===2024?"2025-01-30":"2026-01-30"})));
  return {facts:{"us-gaap":{
    Revenues:{units:{USD:observations(80,100)}},
    NetIncomeLoss:{units:{USD:observations(8,10)}},
    GrossProfit:{units:{USD:observations(40,50)}},
    OperatingIncomeLoss:{units:{USD:observations(16,20)}},
  },dei:{EntityCommonStockSharesOutstanding:{units:{shares:[{end:"2026-01-20",val:100,form:"10-Q",filed:"2026-01-30"}]}}}}};
}
it("derives trailing margins and growth from filed quarters, never later restatements", () => {
  const facts=sec();
  facts.facts["us-gaap"].Revenues.units.USD.push({start:"2025-10-01",end:"2025-12-31",val:999999,form:"10-Q",filed:"2026-02-03"});
  const result=inputsFromSec(facts,asOf,"https://data.sec.gov/test");
  expect(result.inputs.revenueYoY.value).toBe(0.25);
  expect(result.inputs.netMargin.value).toBe(10);
  expect(result.inputs.grossMargin.value).toBe(50);
  expect(result.revenue).toBe(400);
  expect(result.netIncome).toBe(40);
  expect(result.shares?.shares).toBe(100);
  expect(result.inputs.netMargin.asOf).toBe("2026-01-30");
});
it("keeps missing publication dates null instead of relabelling the period end", () => {
  const facts=sec();
  for (const v of facts.facts["us-gaap"].Revenues.units.USD) v.filed="";
  expect(inputsFromSec(facts,asOf,"SEC").inputs.revenueYoY.value).toBeNull();
});
it("does not invent same-day prices or use future bars and split events", () => {
  const source=inputsFromSec(sec(),asOf,"SEC");
  const result=attachMarketInputs(source,[{date:"2026-02-02",close:10},{date:"2026-02-03",close:1000}],
    [{date:"2026-02-03",factor:100}],asOf);
  expect(result.price.value).toBe(10);
  expect(result.peTTM.value).toBe(25);
  expect(result.psTTM.value).toBe(2.5);
  expect(attachMarketInputs(source,[{date:"2026-01-30",close:10}],[],asOf).price.value).toBeNull();
});
it("adjusts the old share count for an effective split before deriving valuation", () => {
  const inputs=attachMarketInputs(inputsFromSec(sec(),asOf,"SEC"),[{date:"2026-02-02",close:5}],
    [{date:"2026-01-25",factor:2}],asOf);
  expect(inputs.peTTM.value).toBe(25);
});
it("derives sector peers only from positive available observations", () => {
  const names=[10,20,30,null].map((pe,i)=>({ticker:`T${i}`,sector:"Tech",inputs:{...emptyInputs(),peTTM:{value:pe,asOf,source:"fixture"}},reasons:[]}));
  attachPeerInputs(names,asOf);
  expect(names[0].inputs.peerPe.value).toBe(20);
  expect(names[0].inputs.peerPs.value).toBeNull();
});

function secWithBalance(equityEnd: string, assetsEnd = equityEnd, debtEnd = equityEnd) {
  const raw = sec();
  const instant = (end: string, val: number) => ({ units: { USD: [
    { end, val, form: "10-Q", filed: "2026-01-30" },
  ] } });
  Object.assign(raw.facts["us-gaap"], {
    StockholdersEquity: instant(equityEnd, 200),
    Assets: instant(assetsEnd, 800),
    LongTermDebt: instant(debtEnd, 100),
    CommercialPaper: instant(debtEnd, 30),
  });
  return raw;
}
it("withholds ROE and ROA when their individual balance periods differ from income TTM", () => {
  const result = inputsFromSec(secWithBalance("2025-09-30", "2025-06-30", "2025-12-31"), asOf, "SEC");
  expect(result.inputs.roe.value).toBeNull();
  expect(result.inputs.roa.value).toBeNull();
});
it("uses only the individually matched asset or equity component", () => {
  const result = inputsFromSec(secWithBalance("2025-12-31", "2025-09-30"), asOf, "SEC");
  expect(result.inputs.roe.value).toBe(20);
  expect(result.inputs.roe.period).toBe("2025-01-01/2025-12-31");
  expect(result.inputs.roa.value).toBeNull();
});
it.each(["2025-09-30", "2025-12-31"])("does not label long-term debt as total debt when borrowings include current debt (%s)", (debtEnd) => {
  const result = inputsFromSec(secWithBalance("2025-12-31", "2025-12-31", debtEnd), asOf, "SEC");
  expect(result.inputs.debtToEquity.value).toBeNull();
  expect(result.inputs.debtToEquity.note).toMatch(/complete.*debt/i);
});
function secThroughMarch() {
  const raw = sec();
  for (const concept of Object.values(raw.facts["us-gaap"])) {
    const previous = concept.units.USD.at(-1)!;
    concept.units.USD.push({ ...previous, start: "2026-01-01", end: "2026-03-31", filed: "2026-05-01" });
  }
  return raw;
}
it("retains filed March TTM at September cutoff with its original period and explicit age", () => {
  const result = inputsFromSec(secThroughMarch(), "2026-09-28T20:00:00.000Z", "SEC");
  expect(result.revenue).toBe(400);
  expect(result.inputs.netMargin.value).toBe(10);
  expect(result.inputs.netMargin.period).toBe("2025-04-01/2026-03-31");
  expect(result.inputs.netMargin.asOf).toBe("2026-05-01");
  expect(result.inputs.netMargin.note).toMatch(/181 days old/);
});
it("withholds TTM data older than 365 calendar days even when recently refiled", () => {
  const raw = secThroughMarch();
  for (const concept of Object.values(raw.facts["us-gaap"]))
    for (const observation of concept.units.USD) observation.filed = "2027-03-30";
  const result = inputsFromSec(raw, "2027-04-02T20:00:00.000Z", "SEC");
  expect(result.revenue).toBeNull();
  expect(result.netIncome).toBeNull();
  expect(result.inputs.netMargin.value).toBeNull();
  expect(result.inputs.revenueYoY.value).toBeNull();
});

it("uses reported total utility revenue when the generic revenue concept is unavailable, without altering evidence", () => {
  const raw = sec();
  const utilityRevenue = structuredClone(raw.facts["us-gaap"].Revenues);
  utilityRevenue.units.USD.push({ start: "2025-10-01", end: "2025-12-31", val: 999999,
    form: "10-Q", filed: "2026-02-03" });
  raw.facts["us-gaap"].Revenues.units.USD = [];
  Object.assign(raw.facts["us-gaap"], { RegulatedAndUnregulatedOperatingRevenue: utilityRevenue });
  const before = structuredClone(raw);
  const result = inputsFromSec(raw, asOf, "SEC");
  expect(result.revenue).toBe(400);
  expect(result.inputs.revenueYoY.value).toBe(0.25);
  expect(result.inputs.netMargin.value).toBe(10);
  expect(result.inputs.revenueYoY.note).toContain("RegulatedAndUnregulatedOperatingRevenue");
  expect(raw).toEqual(before);
});
it("preserves usable generic total revenue instead of overriding it with a utility fallback", () => {
  const raw = sec();
  const utilityRevenue = structuredClone(raw.facts["us-gaap"].Revenues);
  for (const observation of utilityRevenue.units.USD) observation.val *= 2;
  Object.assign(raw.facts["us-gaap"], { RegulatedAndUnregulatedOperatingRevenue: utilityRevenue });
  expect(inputsFromSec(raw, asOf, "SEC").revenue).toBe(400);
});
it("does not substitute an individual utility category for total revenue", () => {
  const raw = sec();
  const category = structuredClone(raw.facts["us-gaap"].Revenues);
  raw.facts["us-gaap"].Revenues.units.USD = [];
  Object.assign(raw.facts["us-gaap"], { RegulatedOperatingRevenue: category, UnregulatedOperatingRevenue: category });
  expect(inputsFromSec(raw, asOf, "SEC").revenue).toBeNull();
});
it("exposes reporting periods for valuation denominators without dating them to the market close", () => {
  const result = inputsFromSec(secThroughMarch(), "2026-09-28T20:00:00.000Z", "SEC");
  expect(result.revenuePeriod).toBe("2025-04-01/2026-03-31");
  expect(result.netIncomePeriod).toBe("2025-04-01/2026-03-31");
  const stale = inputsFromSec(secThroughMarch(), "2027-04-02T20:00:00.000Z", "SEC");
  expect(stale.revenuePeriod).toBeUndefined();
  expect(stale.netIncomePeriod).toBeUndefined();
});

const epsCutoff = "2026-09-28T20:00:00.000Z";
function secWithDirectEps() {
  const raw = sec();
  raw.facts["us-gaap"].Revenues.units.USD = [];
  const eps = [
    { start: "2025-04-01", end: "2025-06-30", val: 1, form: "10-Q", filed: "2026-08-01", accn: "0001-26-000001" },
    { start: "2026-04-01", end: "2026-06-30", val: 1.25, form: "10-Q", filed: "2026-08-01", accn: "0001-26-000001" },
  ];
  Object.assign(raw.facts["us-gaap"], { EarningsPerShareDiluted: { units: { "USD/shares": eps } } });
  return { raw, eps };
}
it("recovers growth only from directly reported matching diluted EPS quarters in the same filing", () => {
  const { raw } = secWithDirectEps();
  const result = inputsFromSec(raw, epsCutoff, "SEC");
  expect(result.inputs.revenueYoY.value).toBeNull();
  expect(result.inputs.epsYoY.value).toBe(0.25);
  expect(result.inputs.epsYoY.period).toBe("2026-04-01/2026-06-30");
  expect(result.inputs.epsYoY.asOf).toBe("2026-08-01");
  expect(result.inputs.epsYoY.note).toMatch(/quarterly/i);
  expect(result.inputs.epsYoY.note).toContain("2025-04-01/2025-06-30");
});
it.each(["different accession", "different filing date", "missing accession", "nonpositive prior", "nonmatching period", "YTD only"])("withholds unsafe direct EPS fallback: %s", (problem) => {
  const { raw, eps } = secWithDirectEps();
  if (problem === "different accession") eps[0].accn = "0001-25-000001";
  if (problem === "different filing date") eps[0].filed = "2025-08-01";
  if (problem === "missing accession") eps[0].accn = eps[1].accn = "";
  if (problem === "nonpositive prior") eps[0].val = 0;
  if (problem === "nonmatching period") { eps[0].start = "2025-05-01"; eps[0].end = "2025-07-31"; }
  if (problem === "YTD only") { eps[0].start = "2025-01-01"; eps[1].start = "2026-01-01"; }
  expect(inputsFromSec(raw, epsCutoff, "SEC").inputs.epsYoY.value).toBeNull();
});
it("preserves filing cutoff and 365-day reporting age for direct EPS", () => {
  const { raw, eps } = secWithDirectEps();
  eps.push({ ...eps[1], val: 100, filed: "2026-09-28", accn: "0001-26-000099" });
  expect(inputsFromSec(raw, epsCutoff, "SEC").inputs.epsYoY.value).toBe(0.25);
  expect(inputsFromSec(raw, "2027-07-02T20:00:00.000Z", "SEC").inputs.epsYoY.value).toBeNull();
});
it("does not change existing revenue growth coverage by adding EPS fallback", () => {
  const { raw } = secWithDirectEps();
  raw.facts["us-gaap"].Revenues = sec().facts["us-gaap"].Revenues;
  const result = inputsFromSec(raw, epsCutoff, "SEC");
  expect(result.inputs.revenueYoY.value).toBe(0.25);
  expect(result.inputs.epsYoY.value).toBeNull();
});

function secWithAnnualTotals() {
  const raw = sec();
  for (const concept of Object.values(raw.facts["us-gaap"])) {
    const priorValue = concept.units.USD[0].val * 4;
    const currentValue = concept.units.USD.at(-1)!.val * 4;
    concept.units.USD = [
      Object.assign({ start: "2024-01-01", end: "2024-12-31", val: priorValue, form: "10-K", filed: "2026-01-30" }, { accn: "0001-26-000010" }),
      Object.assign({ start: "2025-01-01", end: "2025-12-31", val: currentValue, form: "10-K", filed: "2026-01-30" }, { accn: "0001-26-000010" }),
    ];
  }
  return raw;
}
it("uses directly reported full fiscal years when no valid four-quarter TTM exists", () => {
  const result = inputsFromSec(secWithAnnualTotals(), asOf, "SEC");
  expect(result.revenue).toBe(400);
  expect(result.netIncome).toBe(40);
  expect(result.revenuePeriod).toBe("2025-01-01/2025-12-31");
  expect(result.netIncomePeriod).toBe("2025-01-01/2025-12-31");
  expect(result.inputs.revenueYoY.value).toBe(0.25);
  expect(result.inputs.netMargin.value).toBe(10);
  expect(result.inputs.netMargin.note).toMatch(/reported full fiscal year/i);
});
it("does not combine annual income and revenue from different full-year periods", () => {
  const raw = secWithAnnualTotals();
  for (const row of raw.facts["us-gaap"].NetIncomeLoss.units.USD) {
    row.start = row.start.replace("01-01", "04-01");
    row.end = `${Number(row.end.slice(0,4))+1}-03-31`;
  }
  const result = inputsFromSec(raw, "2026-09-28T20:00:00.000Z", "SEC");
  expect(result.revenue).toBe(400);
  expect(result.inputs.netMargin.value).toBeNull();
});
it("requires a same-filing positive previous fiscal year for annual revenue growth", () => {
  const raw = secWithAnnualTotals();
  raw.facts["us-gaap"].Revenues.units.USD[0].filed = "2025-01-30";
  expect(inputsFromSec(raw, asOf, "SEC").inputs.revenueYoY.value).toBeNull();
  raw.facts["us-gaap"].Revenues.units.USD[0].filed = "2026-01-30";
  raw.facts["us-gaap"].Revenues.units.USD[0].val = 0;
  expect(inputsFromSec(raw, asOf, "SEC").inputs.revenueYoY.value).toBeNull();
});
it("withholds stale annual reports and short transition periods", () => {
  expect(inputsFromSec(secWithAnnualTotals(), "2027-01-02T20:00:00.000Z", "SEC").revenue).toBeNull();
  const raw = secWithAnnualTotals();
  for (const concept of Object.values(raw.facts["us-gaap"]))
    for (const row of concept.units.USD) row.start = row.start.replace("01-01", "07-01");
  expect(inputsFromSec(raw, asOf, "SEC").revenue).toBeNull();
});
it("keeps a valid four-quarter total instead of replacing it with annual fallback", () => {
  const raw = sec();
  raw.facts["us-gaap"].Revenues.units.USD.push({start:"2025-01-01",end:"2025-12-31",val:99999,form:"10-K",filed:"2026-01-30"});
  expect(inputsFromSec(raw, asOf, "SEC").revenue).toBe(400);
});
it("accepts a directly reported fiscal-week EPS comparison within the explicit seven-day tolerance", () => {
  const { raw, eps } = secWithDirectEps();
  eps[0].start = "2025-03-30";
  eps[0].end = "2025-06-28";
  eps[1].start = "2026-04-05";
  eps[1].end = "2026-07-04";
  expect(inputsFromSec(raw, epsCutoff, "SEC").inputs.epsYoY.value).toBe(0.25);
});
it("does not use ambiguous EPS observations within one filing", () => {
  const { raw, eps } = secWithDirectEps();
  eps.push({ ...eps[0], val: 2 });
  expect(inputsFromSec(raw, epsCutoff, "SEC").inputs.epsYoY.value).toBeNull();
});
it("keeps annual growth comparisons in the same accession and excludes future annual filings", () => {
  const raw = secWithAnnualTotals();
  Object.assign(raw.facts["us-gaap"].Revenues.units.USD[0], { accn: "different-accession" });
  expect(inputsFromSec(raw, asOf, "SEC").inputs.revenueYoY.value).toBeNull();
  raw.facts["us-gaap"].Revenues.units.USD[1].filed = "2026-02-03";
  expect(inputsFromSec(raw, asOf, "SEC").revenue).toBeNull();
});
