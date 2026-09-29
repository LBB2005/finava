import type { InputFacts, TournamentSnapshot } from "./types";
import { emptyInputs, filterCompanyFacts } from "../facts/pointInTime";
import { extractQuarterlyFundamentals, extractBalanceSnapshot, extractCurrentSharesOutstanding, ttmFromQuarters, type QuarterlyMetric } from "../edgar";
import { validDate } from "../marketCalendar";
import { z } from "zod";

export interface CollectedMember { ticker: string; name: string; sector: string; cik: string }
export interface SecInputs {
  inputs: InputFacts;
  revenue: number | null;
  netIncome: number | null;
  shares: { shares: number; asOf: string } | null;
}
export interface DatedClose { date: string; close: number }
export interface DatedSplit { date: string; factor: number }
export function parseMembershipRevision(raw: unknown, asOf: string): { source: string; availableAt: string; members: CollectedMember[] } {
  const parsed = z.object({query:z.object({pages:z.record(z.string(),z.object({revisions:z.array(z.object({
    revid:z.number().int().positive(),timestamp:z.iso.datetime(),slots:z.object({main:z.object({"*":z.string()})}),
  })).min(1)}))})}).parse(raw);
  const revisions = Object.values(parsed.query.pages).flatMap(p => p.revisions);
  if (revisions.length !== 1 || Date.parse(revisions[0].timestamp) > Date.parse(asOf))
    throw new Error("Constituent revision is ambiguous or after cutoff");
  const revision = revisions[0];
  const table = revision.slots.main["*"].match(/id="constituents"([\s\S]*?)\|}/)?.[1];
  if (!table) throw new Error("Constituent table unavailable");
  const plain = (text: string) => text.replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g,"$1").replace(/<[^>]*>/g,"").trim();
  const members: CollectedMember[] = [];
  for (const row of table.split(/\n\|-\s*\n/)) {
    const cells = row.split("\n").filter(s => s.startsWith("||")).map(s => s.slice(2).trim());
    if (!cells.length) continue;
    const ticker = cells[0].match(/\{\{(?:NyseSymbol|NasdaqSymbol|BZX link)\|([A-Z0-9.-]+)\}\}/i)?.[1];
    const effective = cells[5]?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const cik = cells[6]?.trim();
    if (cells.length !== 8 || !ticker || !effective || !validDate(effective) ||
        effective > asOf.slice(0,10) || !/^\d{1,10}$/.test(cik ?? "") || !cells[2])
      throw new Error("Constituent row lacks valid dated membership fields");
    members.push({ticker,name:plain(cells[1]),sector:plain(cells[2]),cik:cik.padStart(10,"0")});
  }
  if (!members.length || new Set(members.map(m=>m.ticker)).size !== members.length)
    throw new Error("Empty or duplicate constituent table");
  return {source:`https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&oldid=${revision.revid}`,
    availableAt:revision.timestamp,members};
}
export function inputsFromSec(raw: unknown, asOf: string, url: string): SecInputs {
  const filtered = filterCompanyFacts(raw,asOf);
  const inputs = emptyInputs();
  const q = extractQuarterlyFundamentals(filtered,12);
  const balance = extractBalanceSnapshot(filtered);
  const facts = filtered as { facts?: Record<string,Record<string,{units?:Record<string,{filed?:string}[]>}>> } | null;
  const filed = Object.values(facts?.facts ?? {}).flatMap(t => Object.values(t).flatMap(c => Object.values(c.units ?? {}).flat()))
    .map(f=>f.filed??"").sort().at(-1) ?? "";
  const total = (series: QuarterlyMetric[]) => {
    const value=ttmFromQuarters(series);
    return value && Date.parse(asOf)-Date.parse(value.to) <= 180*86400000 ? value : null;
  };
  const revenue=total(q.revenue), income=total(q.netIncome);
  const aligned = (series: QuarterlyMetric[]) => { const value=total(series); return value?.to===revenue?.to ? value?.value ?? null : null; };
  const set = (key:keyof InputFacts,value:number|null,note:string) => {
    if(value!==null && Number.isFinite(value) && filed)
      inputs[key]={value,asOf:filed,source:"SEC EDGAR",url,note};
  };
  const ratio = (numerator:number|null,denominator:number|null,scale=1) =>
    numerator!==null && denominator!==null && denominator>0 ? numerator/denominator*scale : null;
  const prior=ttmFromQuarters(q.revenue.slice(0,-4));
  if (revenue && prior && Math.abs(Date.parse(revenue.to)-Date.parse(prior.to)-365*86400000)<20*86400000)
    set("revenueYoY",ratio(revenue.value-prior.value,prior.value),"Trailing four quarters versus preceding four; filed before cutoff");
  set("grossMargin",ratio(aligned(q.grossProfit),revenue?.value??null,100),"Trailing gross profit / matched revenue, percent");
  set("operatingMargin",ratio(aligned(q.operatingIncome),revenue?.value??null,100),"Trailing operating income / matched revenue, percent");
  set("netMargin",ratio(aligned(q.netIncome),revenue?.value??null,100),"Trailing net income / matched revenue, percent");
  const freshBalance=balance.asOf && Date.parse(asOf)-Date.parse(balance.asOf)<=180*86400000;
  if(freshBalance) {
    set("roe",ratio(income?.value??null,balance.equity,100),"Trailing income / latest filed equity, percent");
    set("roa",ratio(income?.value??null,balance.totalAssets,100),"Trailing income / latest filed assets, percent");
    set("debtToEquity",ratio(balance.totalDebt,balance.equity),"Latest filed debt / equity");
  }
  const ocf=total(q.operatingCashFlow),capex=total(q.capex);
  if(ocf && capex && income && ocf.to===capex.to && ocf.to===income.to)
    set("fcfConversion",ratio(ocf.value-capex.value,income.value),"Trailing operating cash flow less capex / income");
  const shares=extractCurrentSharesOutstanding(filtered);
  return {inputs,revenue:revenue?.value??null,netIncome:income?.value??null,
    shares:shares && Date.parse(asOf)-Date.parse(shares.asOf)<=400*86400000 ? shares : null};
}
export function attachMarketInputs(source: SecInputs, bars: DatedClose[], splits: DatedSplit[], asOf: string): InputFacts {
  const inputs=structuredClone(source.inputs), date=asOf.slice(0,10);
  const effective=splits.filter(s=>validDate(s.date)&&s.date<=date&&Number.isFinite(s.factor)&&s.factor>0);
  const series=bars.filter(b=>validDate(b.date)&&b.date<=date&&Number.isFinite(b.close)&&b.close>0).sort((a,b)=>a.date.localeCompare(b.date));
  if(new Set(series.map(b=>b.date)).size!==series.length) throw new Error("Duplicate daily prices");
  const last=series.at(-1);
  if(last?.date!==date) return inputs;
  const set=(key:keyof InputFacts,value:number|null,note:string)=>{
    if(value!==null&&Number.isFinite(value))inputs[key]={value,asOf,source:"Alpaca SIP / filed SEC inputs",note};
  };
  set("price",last.close,"Unadjusted regular-session close; observation date matches scoring session");
  const adjusted=series.map(b=>b.close/effective.filter(s=>s.date>b.date).reduce((n,s)=>n*s.factor,1));
  if(adjusted.length>=200)set("trendVs200",last.close/(adjusted.slice(-200).reduce((a,b)=>a+b,0)/200)-1,"Close / 200 observed-session mean - 1; splits effective by cutoff only");
  if(adjusted.length>=64)set("ret3m",last.close/adjusted.at(-64)!-1,"63 observed-session price return; splits effective by cutoff only");
  if(source.shares && source.shares.asOf<=date) {
    const shares=source.shares.shares*effective.filter(s=>s.date>source.shares!.asOf).reduce((n,s)=>n*s.factor,1);
    const cap=last.close*shares;
    set("peTTM",source.netIncome!==null&&source.netIncome>0 ? cap/source.netIncome : null,"Close × filed cover-page shares, adjusted for subsequent splits / trailing net income");
    set("psTTM",source.revenue!==null&&source.revenue>0 ? cap/source.revenue : null,"Close × filed cover-page shares, adjusted for subsequent splits / trailing revenue");
  }
  return inputs;
}
export function attachPeerInputs(names: TournamentSnapshot["names"], asOf: string): void {
  for(const name of names)for(const [key,peer] of [["peTTM","peerPe"],["psTTM","peerPs"]] as const) {
    const values=names.filter(n=>n.sector===name.sector).map(n=>n.inputs[key].value)
      .filter((n):n is number=>n!==null&&Number.isFinite(n)&&n>0).sort((a,b)=>a-b);
    if(values.length<3)continue;
    const mid=Math.floor(values.length/2),value=values.length%2?values[mid]:(values[mid-1]+values[mid])/2;
    name.inputs[peer]={value,asOf,source:"Same dated universe",note:`Sector median of ${values.length} positive available ${key} observations`};
  }
}
