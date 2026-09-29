import type { InputFacts, TournamentSnapshot } from "./types";
import { emptyInputs, filterCompanyFacts } from "../facts/pointInTime";
import { extractQuarterlyFundamentals, extractCurrentSharesOutstanding, ttmFromQuarters, type QuarterlyMetric, type TtmTotal } from "../edgar";
import { validDate } from "../marketCalendar";
import { z } from "zod";

export interface CollectedMember { ticker: string; name: string; sector: string; cik: string }
export interface SecInputs {
  inputs: InputFacts;
  revenue: number | null;
  netIncome: number | null;
  revenuePeriod?: string;
  netIncomePeriod?: string;
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
    // Wikitext permits either a leading single pipe or a double pipe, and
    // adjacent cells can share one line. Single pipes inside links/templates
    // are not cell separators.
    const cells = row.split(/\|\||(?:^|\n)[ \t]*\|{1,2}(?![!-])/).slice(1).map(s => s.trim());
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
// Preserve the period of each balance component; a merged snapshot date can
// otherwise make an old asset/equity observation look contemporaneous.
interface SecObservation {
  start?: string;
  end?: string;
  val?: number;
  form?: string;
  filed?: string;
  accn?: string;
}
type SecConcepts = Record<string, { units?: Record<string, SecObservation[]> }>;
function latestBalanceComponent(concepts: SecConcepts, keys: string[]) {
  let latest: { value: number; end: string; filed: string } | null = null;
  for (const key of keys) for (const fact of concepts[key]?.units?.USD ?? []) {
    if (fact.start || !fact.end || !fact.filed ||
        !/^10-[KQ](\/A)?$/.test(fact.form ?? "") ||
        typeof fact.val !== "number" || !Number.isFinite(fact.val)) continue;
    if (!latest || fact.end > latest.end ||
        (fact.end === latest.end && fact.filed > latest.filed))
      latest = { value: fact.val, end: fact.end, filed: fact.filed };
  }
  return latest;
}
function directQuarterlyEpsGrowth(concepts: SecConcepts, asOf: string) {
  type EpsQuarter = Required<Pick<SecObservation, "start" | "end" | "val" | "filed" | "accn">>;
  const days = (from: string, to: string) => (Date.parse(to)-Date.parse(from))/86400000;
  const quarters = (concepts.EarningsPerShareDiluted?.units?.["USD/shares"] ?? [])
    .filter((f): f is EpsQuarter => !!f.start && !!f.end && !!f.filed && !!f.accn &&
      /^10-[KQ](\/A)?$/.test(f.form ?? "") && typeof f.val === "number" && Number.isFinite(f.val) &&
      days(f.start,f.end)>=60 && days(f.start,f.end)<=125)
    .sort((a,b)=>a.end.localeCompare(b.end)||a.filed.localeCompare(b.filed)||a.accn.localeCompare(b.accn));
  const current = quarters.at(-1);
  if (!current || days(current.end,asOf.slice(0,10))<0 || days(current.end,asOf.slice(0,10))>365) return null;
  const sameFiling = quarters.filter(f=>f.accn===current.accn && f.filed===current.filed);
  if (sameFiling.some(f=>f.end===current.end && (f.start!==current.start || f.val!==current.val))) return null;
  // The comparative quarter in the same filing carries the issuer's reported
  // per-share basis. Never subtract YTD or annual EPS to invent a quarter.
  // Seven days permits the issuer's 52/53-week fiscal-calendar shift.
  const matches = sameFiling.filter(f=>Math.abs(days(f.start,current.start)-365)<=7 &&
    Math.abs(days(f.end,current.end)-365)<=7 && f.val>0);
  const unique = new Map(matches.map(f=>[`${f.start}/${f.end}/${f.val}`,f]));
  if (unique.size!==1) return null;
  const prior = [...unique.values()][0];
  return {value:current.val/prior.val-1,period:{from:current.start,to:current.end},filed:current.filed,
    note:`Direct quarterly diluted EPS versus ${prior.start}/${prior.end}; same filing ${current.accn}; prior-year boundaries within 7 days`};
}
const REVENUE_CONCEPTS = ["Revenues","RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax","RevenuesNetOfInterestExpense",
  "RegulatedAndUnregulatedOperatingRevenue"];
const INCOME_CONCEPTS = ["NetIncomeLoss","NetIncomeLossAvailableToCommonStockholdersBasic","ProfitLoss"];
function reportedAnnualTotals(concepts: SecConcepts, keys: string[]) {
  const values: (TtmTotal & {filed:string;accn:string;concept:string})[] = [];
  for (const concept of keys) for (const f of concepts[concept]?.units?.USD ?? []) {
    if (!f.start || !f.end || !f.filed || !f.accn || !/^10-K(\/A)?$/.test(f.form ?? "") ||
        typeof f.val!=="number" || !Number.isFinite(f.val)) continue;
    const days=(Date.parse(f.end)-Date.parse(f.start))/86400000;
    // A direct full fiscal year (including 52/53-week years), never a short
    // transition report or annualized/interpolated partial-period observation.
    if (days<350 || days>380) continue;
    values.push({value:f.val,from:f.start,to:f.end,filed:f.filed,accn:f.accn,concept});
  }
  return values.sort((a,b)=>a.to.localeCompare(b.to)||a.filed.localeCompare(b.filed)||
    keys.indexOf(b.concept)-keys.indexOf(a.concept));
}
export function inputsFromSec(raw: unknown, asOf: string, url: string): SecInputs {
  const filtered = filterCompanyFacts(raw,asOf);
  const inputs = emptyInputs();
  const q = extractQuarterlyFundamentals(filtered,12);
  const facts = filtered as { facts?: Record<string, SecConcepts> } | null;
  const concepts = facts?.facts?.["us-gaap"] ?? {};
  const filed = Object.values(facts?.facts ?? {}).flatMap(t => Object.values(t).flatMap(c => Object.values(c.units ?? {}).flat()))
    .map(f=>f.filed??"").sort().at(-1) ?? "";
  const age = (end: string) => Math.floor((Date.parse(asOf.slice(0,10))-Date.parse(end))/86400000);
  const total = (series: QuarterlyMetric[]) => {
    const value=ttmFromQuarters(series);
    return value && age(value.to) >= 0 && age(value.to) <= 365 ? value : null;
  };
  let revenueConcept = "reported total revenue";
  // Utility issuers such as DTE report this explicit aggregate instead of the
  // generic revenue concepts. Extract the actual total without adding segment
  // categories or modifying the archived companyfacts response.
  if (!total(q.revenue) && concepts.RegulatedAndUnregulatedOperatingRevenue) {
    const utility = extractQuarterlyFundamentals({ facts: { "us-gaap": {
      Revenues: concepts.RegulatedAndUnregulatedOperatingRevenue,
    } } },12).revenue;
    if (total(utility)) {
      q.revenue = utility;
      revenueConcept = "RegulatedAndUnregulatedOperatingRevenue";
    }
  }
  const annuals = (keys:string[]) => reportedAnnualTotals(concepts,keys);
  const freshAnnual = (keys:string[]) => annuals(keys).filter(v=>age(v.to)>=0 && age(v.to)<=365).at(-1) ?? null;
  const quarterlyRevenue=total(q.revenue), quarterlyIncome=total(q.netIncome);
  const annualRevenue=quarterlyRevenue ? null : freshAnnual(REVENUE_CONCEPTS);
  const annualIncome=quarterlyIncome ? null : freshAnnual(INCOME_CONCEPTS);
  const revenue=quarterlyRevenue ?? annualRevenue, income=quarterlyIncome ?? annualIncome;
  if (annualRevenue) revenueConcept=`${annualRevenue.concept}, reported full fiscal year`;
  const aligned = (series: QuarterlyMetric[], keys:string[]) => {
    const value=total(series);
    if (value && value.from===revenue?.from && value.to===revenue?.to) return value.value;
    return annuals(keys).filter(v=>v.from===revenue?.from && v.to===revenue?.to).at(-1)?.value ?? null;
  };
  const set = (key:keyof InputFacts,value:number|null,note:string,period:Pick<TtmTotal,"from"|"to">|null,publication=filed) => {
    if(value!==null && Number.isFinite(value) && publication && period)
      inputs[key]={value,asOf:publication,source:"SEC EDGAR",url,period:`${period.from}/${period.to}`,
        note:`${note}; reporting period ends ${period.to} (${age(period.to)} days old at cutoff; maximum 365 days)`};
  };
  const ratio = (numerator:number|null,denominator:number|null,scale=1) =>
    numerator!==null && denominator!==null && denominator>0 ? numerator/denominator*scale : null;
  const prior=ttmFromQuarters(q.revenue.slice(0,-4));
  if (quarterlyRevenue && prior && Math.abs(Date.parse(quarterlyRevenue.to)-Date.parse(prior.to)-365*86400000)<20*86400000)
    set("revenueYoY",ratio(quarterlyRevenue.value-prior.value,prior.value),`Trailing four quarters versus preceding four (${prior.from}/${prior.to}); ${revenueConcept}; filed before cutoff`,quarterlyRevenue);
  if (annualRevenue) {
    const comparisons=annuals([annualRevenue.concept]).filter(v=>v.accn===annualRevenue.accn &&
      v.filed===annualRevenue.filed && v.value>0 &&
      Math.abs((Date.parse(annualRevenue.from)-Date.parse(v.from))/86400000-365)<=7 &&
      Math.abs((Date.parse(annualRevenue.to)-Date.parse(v.to))/86400000-365)<=7);
    const unique=new Map(comparisons.map(v=>[`${v.from}/${v.to}/${v.value}`,v]));
    if (unique.size===1) {
      const previous=[...unique.values()][0];
      set("revenueYoY",annualRevenue.value/previous.value-1,
        `Reported full fiscal year ${annualRevenue.concept} versus ${previous.from}/${previous.to}; same filing ${annualRevenue.accn}`,
        annualRevenue,annualRevenue.filed);
    }
  }
  if (inputs.revenueYoY.value===null) {
    const eps=directQuarterlyEpsGrowth(concepts,asOf);
    if (eps) set("epsYoY",eps.value,eps.note,eps.period,eps.filed);
  }
  set("grossMargin",ratio(aligned(q.grossProfit,["GrossProfit"]),revenue?.value??null,100),`Trailing gross profit / matched ${revenueConcept}, percent`,revenue);
  set("operatingMargin",ratio(aligned(q.operatingIncome,["OperatingIncomeLoss"]),revenue?.value??null,100),`Trailing operating income / matched ${revenueConcept}, percent`,revenue);
  set("netMargin",ratio(aligned(q.netIncome,INCOME_CONCEPTS),revenue?.value??null,100),`Trailing net income / matched ${revenueConcept}, percent`,revenue);
  const equity = latestBalanceComponent(concepts,["StockholdersEquity","StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]);
  const assets = latestBalanceComponent(concepts,["Assets"]);
  if (income && equity?.end === income.to)
    set("roe",ratio(income.value,equity.value,100),"Trailing income / equity at the same reporting-period end, percent",income);
  if (income && assets?.end === income.to)
    set("roa",ratio(income.value,assets.value,100),"Trailing income / assets at the same reporting-period end, percent",income);
  // LongTermDebt alone excludes commercial paper and other current borrowings.
  // Omitted XBRL concepts do not prove those liabilities are zero.
  inputs.debtToEquity={value:null,asOf:filed,source:"SEC EDGAR",url,
    note:"Complete same-period debt decomposition is not proven; long-term debt alone is not total debt"};
  const ocf=total(q.operatingCashFlow),capex=total(q.capex);
  if(ocf && capex && income && ocf.to===capex.to && ocf.to===income.to)
    set("fcfConversion",ratio(ocf.value-capex.value,income.value),"Trailing operating cash flow less capex / income",income);
  const shares=extractCurrentSharesOutstanding(filtered);
  return {inputs,revenue:revenue?.value??null,netIncome:income?.value??null,
    ...(revenue ? { revenuePeriod: `${revenue.from}/${revenue.to}` } : {}),
    ...(income ? { netIncomePeriod: `${income.from}/${income.to}` } : {}),
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
