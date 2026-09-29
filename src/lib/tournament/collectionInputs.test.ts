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
