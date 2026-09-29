import type { TournamentSnapshot } from "./types";
import { shiftDate, validDate, type MarketSession } from "../marketCalendar";
import {
  parseMembershipRevision, inputsFromSec, attachMarketInputs, attachPeerInputs,
  type DatedClose, type DatedSplit,
} from "./collectionInputs";
import { parseSnapshot } from "./sources";
import { attachReferenceValuation, referenceUrl } from "./liveValuation";

export interface SnapshotCollectionConfig {
  get:(url:string)=>Promise<unknown>;
  calendar:{range:(start:string,end:string)=>Promise<MarketSession[]>};
  market:{history:(ticker:string,start:string,end:string)=>Promise<{bars:DatedClose[];splits:DatedSplit[];reasons:string[]}>};
  now?:()=>Date;
  onProgress?:(done:number,total:number)=>void;
}
export class LiveSnapshots {
  constructor(private config:SnapshotCollectionConfig) {}
  async collect(date:string):Promise<TournamentSnapshot> {
    if (!validDate(date)) throw new Error("Invalid collection date");
    const now=this.config.now ?? (()=>new Date());
    const sessions=await this.config.calendar.range(date,date);
    const session=sessions.find(s=>s.date===date);
    if (!session || Date.parse(session.close)>now().getTime())
      throw new Error("A completed exchange session is required for collection");
    const query=new URLSearchParams({action:"query",prop:"revisions",titles:"List_of_S&P_500_companies",
      rvprop:"ids|timestamp|content",rvslots:"main",rvstart:session.close,rvlimit:"1",format:"json"});
    const revision=parseMembershipRevision(await this.config.get(`https://en.wikipedia.org/w/api.php?${query}`),session.close);
    if (revision.members.length<500 || revision.members.length>520)
      throw new Error(`Unexpected S&P universe size: ${revision.members.length}`);
    const names:TournamentSnapshot["names"]=new Array(revision.members.length);
    let next=0,done=0;
    const worker=async()=>{
      while(next<revision.members.length) {
        const index=next++, member=revision.members[index];
        const url=`https://data.sec.gov/api/xbrl/companyfacts/CIK${member.cik}.json`;
        const [sec,market,reference]=await Promise.allSettled([
          this.config.get(url),this.config.market.history(member.ticker,shiftDate(date,-400),date),
          this.config.get(referenceUrl(member.ticker,date)),
        ]);
        const reasons:string[]=[];
        const errorText=(reason:unknown)=>reason instanceof Error?reason.message:"Provider unavailable";
        if(sec.status==="rejected")reasons.push(`SEC unavailable: ${errorText(sec.reason)}`);
        const fundamentals=inputsFromSec(sec.status==="fulfilled"?sec.value:null,session.close,url);
        let inputs=fundamentals.inputs;
        if(market.status==="rejected")reasons.push(`Market unavailable: ${errorText(market.reason)}`);
        else if(market.value.reasons.length)reasons.push(...market.value.reasons);
        else inputs=attachMarketInputs(fundamentals,market.value.bars,market.value.splits,session.close);
        if(reference.status==="rejected")reasons.push(`Valuation reference unavailable: ${errorText(reference.reason)}`);
        inputs=attachReferenceValuation(inputs,fundamentals,reference.status==="fulfilled"?reference.value:null,member,session.close,
          market.status==="fulfilled" && !market.value.reasons.length ? market.value.splits : null);
        names[index]={ticker:member.ticker,sector:member.sector,inputs,reasons};
        done++;
        if(done%25===0 || done===revision.members.length)this.config.onProgress?.(done,revision.members.length);
      }
    };
    await Promise.all(Array.from({length:4},worker));
    attachPeerInputs(names,session.close);
    return parseSnapshot({evidenceClass:"prospective",asOf:session.close,observedAt:now().toISOString(),
      membership:{date,source:revision.source,verified:true,
        members:revision.members.map(({ticker,name,sector})=>({ticker,name,sector}))},names});
  }
}
