import { describe, expect, it } from "vitest";
import { rankStrategies, modelShortlist, earningsRevisions } from "./strategies";
import { cleanInputs, emptyInputs } from "../facts/pointInTime";
import { buildPredictionRecord, isMatured } from "../investment/evaluation/predictions";
import { resolvePrediction, NON_RESOLUTION } from "../investment/evaluation/outcomes";
import { makePrediction } from "./predictions";
import { makeBatch, verifyBatches, MemoryTournamentLedger } from "../live/ledgerTournament";
import type { TournamentSnapshot } from "./types";
export const snapshot = (): TournamentSnapshot => ({ asOf:"2026-07-02T17:00:00.000Z", observedAt:"2026-07-02T18:00:00.000Z", membership:{ date:"2026-07-02",source:"test fixture",verified:true,members:Array.from({length:30},(_,i)=>({ticker:`T${i}`,name:`Test ${i}`,sector:"test"})) }, names:Array.from({length:30},(_,i)=>({ticker:`T${i}`,sector:"test",inputs:{...emptyInputs(),price:{value:100,asOf:"2026-07-02T17:00:00.000Z",source:"fixture"},revenueYoY:{value:i/100,asOf:"2026-07-01T20:00:00Z",source:"fixture"},netMargin:{value:i,asOf:"2026-07-01T20:00:00Z",source:"fixture"},peTTM:{value:30-i/2,asOf:"2026-07-02T17:00:00Z",source:"fixture"},peerPe:{value:20,asOf:"2026-07-02T17:00:00Z",source:"fixture"},ret3m:{value:i/100-.15,asOf:"2026-07-02T17:00:00Z",source:"fixture"}},reasons:[]})) });
export const window = {entryDate:"2026-07-06",entryAt:"2026-07-06T13:30:00.000Z",targetDate:"2026-07-06",targetAt:"2026-07-06T20:00:00.000Z"};
export function row() { const s=snapshot(); return makePrediction({snapshot:s,arm:"growth",ticker:"T29",rank:1,decile:10,disposition:"long",horizon:1,window,codeSha:"a".repeat(40),registrationHash:"b".repeat(64),createdAt:s.observedAt}); }
describe("tournament integrity",()=>{
 it("removes future and undated facts before scores are computed",()=>{
  const inputs=emptyInputs(); inputs.revenueYoY={value:100,asOf:"2026-07-03T00:00:00Z",source:"future"}; inputs.price={value:100,asOf:"",source:"undated"};
  const clean=cleanInputs(inputs,"2026-07-02T17:00:00Z"); expect(clean.values.revenueYoY).toBeNull();expect(clean.values.price).toBeNull();expect(clean.reasons.length).toBeGreaterThanOrEqual(2);
 });
 it("ranks all names, records neutrals and unscored names, never manufactures earnings revisions",()=>{
  const s=snapshot(); s.names[0].inputs=emptyInputs(); const arms=rankStrategies(s);const growth=arms.growth;
  expect(growth).toHaveLength(30);expect(growth.filter(r=>r.disposition==="long")).toHaveLength(10);expect(growth.filter(r=>r.disposition==="avoid")).toHaveLength(10);expect(growth.find(r=>r.ticker==="T0")?.disposition).toBe("unscored");expect(modelShortlist(arms).length).toBeLessThanOrEqual(25);expect(earningsRevisions().status).toBe("unavailable");
 });
 it("matures at close, grades from next open, and records target definitions",()=>{
  const r=row(); expect(r.prediction.evaluationWindow?.entryAt).toBe(window.entryAt);expect(isMatured(r.prediction,new Date("2026-07-06T18:00:00Z"))).toBe(false);
  const series={symbol:"T29",windowStart:window.entryDate,windowEnd:window.targetDate,startPrice:100,endPrice:110,distributions:[],corporateActionAdjusted:true,adjustmentSource:"fixture"};
  const data={subject:series,benchmark:{...series,symbol:"SPY",endPrice:105},corporateAction:null,invalidationObservations:[]};
  const result=resolvePrediction(r.prediction,data,{now:new Date("2026-07-06T21:00:00Z")});expect(result.status).toBe("resolved");if(result.status==="resolved")expect(result.outcome.excessReturn).toBeCloseTo(.05);
  expect(resolvePrediction(r.prediction,{...data,subject:{...series,windowStart:"2026-07-02"}},{now:new Date("2026-07-06T21:00:00Z")})).toMatchObject({status:"unresolved",reason:NON_RESOLUTION.windowMismatch});
 });
 it("rejects late writes and never updates or deletes published predictions",async()=>{
  const ledger=new MemoryTournamentLedger(); const r=row(); const b=makeBatch([r],null,{date:"2026-07-02",asOf:r.prediction.asOf,codeSha:r.codeSha,registrationHash:r.registrationHash,createdAt:r.prediction.createdAt,snapshotHash:r.snapshotHash,namespace:"tournament_dryrun"});
  await ledger.appendBatch(b,[r]); expect(await ledger.appendBatch(b,[r])).toBe("duplicate");expect(()=>ledger.update()).toThrow(/append-only/);expect(()=>ledger.delete()).toThrow(/append-only/);
  expect(verifyBatches([{batch:b,rows:[r]}]).valid).toBe(true);const mutated=structuredClone(r);mutated.prediction.forecasts.outperformBenchmark=.99;expect(verifyBatches([{batch:b,rows:[mutated]}]).valid).toBe(false);
  const late={...r,prediction:{...r.prediction,createdAt:window.entryAt}};const lb=makeBatch([late],null,{...b,createdAt:window.entryAt});await expect(new MemoryTournamentLedger().appendBatch(lb,[late])).rejects.toThrow(/entry/);
 });
 it("retains delistings with unknown proceeds as NON_RESOLUTION",()=>{
  const r=row();r.prediction.targetDate="2026-07-07";r.prediction.evaluationWindow!.targetAt="2026-07-07T20:00:00Z";
  const series={symbol:"T29",windowStart:window.entryDate,windowEnd:window.entryDate,startPrice:100,endPrice:null,distributions:[],corporateActionAdjusted:true,adjustmentSource:"fixture"};
  const result=resolvePrediction(r.prediction,{subject:series,benchmark:{...series,symbol:"SPY",endPrice:100},corporateAction:{kind:"delisting",effectiveDate:window.entryDate,proceedsPerShare:null,detail:"No proceeds available"},invalidationObservations:[]},{now:new Date("2026-07-08T00:00:00Z")});
  expect(result.status).toBe("resolved");if(result.status==="resolved")expect(result.outcome.unresolvedReasons).toContain(NON_RESOLUTION.proceedsUnknown);
 });
});
