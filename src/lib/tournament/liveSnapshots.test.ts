import { it, expect } from "vitest";
import { LiveSnapshots, type SnapshotCollectionConfig } from "./liveSnapshots";
const close="2026-02-02T21:00:00.000Z";
const members=(count=500)=>({query:{pages:{one:{revisions:[{revid:100,timestamp:"2026-02-01T12:00:00Z",slots:{main:{"*":'id="constituents"\n'+Array.from({length:count},(_,i)=>`|-\n|| {{NyseSymbol|T${i}}}\n|| Company ${i}\n|| Technology\n|| Software\n|| US\n|| 2020-01-01\n|| ${1000+i}\n|| 2000\n`).join('')+'|}'}}}]}}}});
const facts=()=> {
 const series=(previous:number,current:number)=>[2024,2025].flatMap(y=>[['01-01','03-31'],['04-01','06-30'],['07-01','09-30'],['10-01','12-31']].map(([start,end])=>({start:`${y}-${start}`,end:`${y}-${end}`,filed:y===2024?'2025-01-30':'2026-01-30',form:'10-Q',val:y===2024?previous:current})));
 return {facts:{'us-gaap':{Revenues:{units:{USD:series(80,100)}},NetIncomeLoss:{units:{USD:series(8,10)}}},dei:{EntityCommonStockSharesOutstanding:{units:{shares:[{end:'2026-01-20',filed:'2026-01-30',form:'10-Q',val:100}]}}}}};
};
function config(count=500): SnapshotCollectionConfig {
 return {get:async(url:string)=>url.includes('wikipedia')?members(count):url.includes('massive.com')?{status:'OK',results:{ticker:url.split('/').at(-1)!.split('?')[0],cik:String(1000+Number(url.match(/T(\d+)/)![1])).padStart(10,'0'),currency_name:'usd',weighted_shares_outstanding:200}}:facts(),
  calendar:{range:async()=>[{date:'2026-02-02',open:'2026-02-02T14:30:00.000Z',close}]},
  market:{history:async()=>({bars:[{date:'2026-02-02',close:10}],splits:[],reasons:[]})},
  now:()=>new Date('2026-02-02T22:00:00Z')};
}
it('collects a dated full universe with real nulls and source-specific publication dates',async()=>{
 const snapshot=await new LiveSnapshots(config()).collect('2026-02-02');
 expect(snapshot.membership.members).toHaveLength(500);
 expect(snapshot.membership.source).toContain('oldid=100');
 expect(snapshot.observedAt).toBe('2026-02-02T22:00:00.000Z');
 expect(snapshot.names[0].inputs.price.value).toBe(10);
 expect(snapshot.names[0].inputs.psTTM.value).toBe(5);
 expect(snapshot.names[0].inputs.revenueYoY).toMatchObject({value:0.25,asOf:'2026-01-30'});
 expect(snapshot.names[0].inputs.dcfFair.value).toBeNull();
});
it('retains unavailable issuers rather than shrinking the universe or inventing fundamentals',async()=>{
 const c=config();const get=c.get;
 c.get=async url=>{if(url.includes('CIK0000001000'))throw new Error('SEC missing');return get(url);};
 const s=await new LiveSnapshots(c).collect('2026-02-02');
 expect(s.names).toHaveLength(500);
 expect(s.names[0].inputs.revenueYoY.value).toBeNull();
 expect(s.names[0].reasons.join(' ')).toContain('SEC missing');
 expect(s.names[1].inputs.revenueYoY.value).toBe(0.25);
});
it('rejects incomplete membership and uncompleted sessions before paid scoring',async()=>{
 await expect(new LiveSnapshots(config(10)).collect('2026-02-02')).rejects.toThrow(/universe/);
 await expect(new LiveSnapshots({...config(),now:()=>new Date('2026-02-02T20:00:00Z')}).collect('2026-02-02')).rejects.toThrow(/completed/);
});
it('withholds split-dependent price factors when action coverage is unknown',async()=>{
 const c=config();c.market.history=async()=>({bars:[{date:'2026-02-02',close:10}],splits:[],reasons:['split terms missing']});
 const s=await new LiveSnapshots(c).collect('2026-02-02');
 expect(s.names[0].inputs.psTTM.value).toBeNull();
 expect(s.names[0].reasons).toContain('split terms missing');
});

it('withholds SEC cover-page valuation if dated issuer reference fails',async()=>{
 const c=config(),get=c.get;c.get=async url=>{if(url.includes('massive.com'))throw new Error('Reference unavailable');return get(url);};
 const s=await new LiveSnapshots(c).collect('2026-02-02');
 expect(s.names[0].inputs.psTTM.value).toBeNull();
 expect(s.names[0].reasons.join(' ')).toContain('Reference unavailable');
});

it('requests prior-calendar-date issuer references for the scoring-session cutoff',async()=>{
 const c=config(),get=c.get;const urls:string[]=[];
 c.get=async url=>{if(url.includes('massive.com'))urls.push(url);return get(url);};
 await new LiveSnapshots(c).collect('2026-02-02');
 expect(urls).toHaveLength(500);expect(urls.every(url=>url.endsWith('date=2026-02-01'))).toBe(true);
});
