import { z } from 'zod';
import type { InputFacts } from './types';
import type { SecInputs, DatedSplit } from './collectionInputs';
import {shiftDate} from '../marketCalendar';
const reference=z.object({status:z.literal('OK'),results:z.object({ticker:z.string(),cik:z.string(),
 currency_name:z.literal('usd'),weighted_shares_outstanding:z.number().finite().positive()})});
export const referenceUrl=(ticker:string,scoringDate:string)=>`https://api.massive.com/v3/reference/tickers/${encodeURIComponent(ticker)}?date=${shiftDate(scoringDate,-1)}`;
/** Massive weighted shares express the whole issuer in the requested class's units.
 * https://massive.com/knowledge-base/article/what-is-the-difference-between-weighted-shares-outstanding-and-share-class-shares-outstanding
 * This is a provider-defined class-equivalent valuation, not a sum across classes.
 */
export function attachReferenceValuation(inputs:InputFacts,fundamentals:SecInputs,raw:unknown,
 member:{ticker:string;cik:string},asOf:string,splits:DatedSplit[]|null=[]):InputFacts {
 const result=structuredClone(inputs),url=referenceUrl(member.ticker,asOf.slice(0,10));
 for(const key of ['peTTM','psTTM'] as const)result[key]={value:null,asOf,source:'Massive dated reference / SEC EDGAR',url,note:'Dated issuer-equivalent shares or matched financial denominator unavailable'};
 const parsed=reference.safeParse(raw),price=inputs.price;
 if(!parsed.success || parsed.data.results.ticker!==member.ticker ||
    parsed.data.results.cik.padStart(10,'0')!==member.cik || price.asOf!==asOf || price.value===null || price.value<=0)return result;
 if(splits===null)return result;
 const current=splits.filter(split=>split.date===asOf.slice(0,10));
 if(current.some(split=>!Number.isFinite(split.factor)||split.factor<=0))return result;
 const factor=current.reduce((product,split)=>product*split.factor,1);
 const cap=price.value*parsed.data.results.weighted_shares_outstanding*factor;
 for(const [key,denominator,period] of [['peTTM',fundamentals.netIncome,fundamentals.netIncomePeriod],['psTTM',fundamentals.revenue,fundamentals.revenuePeriod]] as const) {
  const age=period?Math.floor((Date.parse(asOf.slice(0,10))-Date.parse(period.split('/')[1]))/86400000):null;
  if(denominator!==null&&denominator>0&&Number.isFinite(cap/denominator))result[key]={value:cap/denominator,asOf,
   source:'Massive dated reference / Alpaca SIP / SEC EDGAR',url,...(period?{period}:{}),
   note:`Session close × provider class-equivalent issuer shares (reference date ${shiftDate(asOf.slice(0,10),-1)}; scoring-day share-basis factor ${factor}; adjustments ${JSON.stringify(current)}) / filed trailing `+(key==='peTTM'?'net income':'revenue')+
    (period?`; reporting interval ${period} (${age} days old at cutoff)`:'')+'; share classes valued individually, never summed'};
 }

 return result;
}
