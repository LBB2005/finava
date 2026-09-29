import {beforeEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({docs:new Map<string,Record<string,unknown>>(),queue:Promise.resolve()}));
vi.mock('@/lib/firebase-admin',()=>{
 const ref=(path:string)=>({path,get:async()=>({data:()=>structuredClone(state.docs.get(path))})});
 return {db:{collection:(name:string)=>({doc:(id:string)=>ref(`${name}/${id}`)}),
  runTransaction:(work:(tx:unknown)=>Promise<unknown>)=>{
   const result=state.queue.then(async()=>{
    const writes:(()=>void)[]=[];
    const result=await work({get:async(r:{path:string})=>({data:()=>structuredClone(state.docs.get(r.path))}),
     set:(r:{path:string},data:Record<string,unknown>)=>writes.push(()=>state.docs.set(r.path,structuredClone(data))),
     update:(r:{path:string},data:Record<string,unknown>)=>writes.push(()=>{
      const target=structuredClone(state.docs.get(r.path)!);
      for(const[key,value]of Object.entries(data)){
       const parts=key.split('.');let current=target;
       for(const part of parts.slice(0,-1))current=current[part] as Record<string,unknown>;
       current[parts.at(-1)!]=value;
      }
      state.docs.set(r.path,target);
     })});
    writes.forEach(write=>write());return result;
   });
   state.queue=result.then(()=>undefined,()=>undefined);return result;
  }}};
});
import {tournamentReservations} from './budget';
beforeEach(()=>{state.docs.clear();state.queue=Promise.resolve();});
const day='2026-09-29';
it.each(['tournament','tournament_dryrun'] as const)('shares the daily cap when %s reserves first',async(first)=>{
 const a=tournamentReservations(day,first),b=tournamentReservations(day,first==='tournament'?'tournament_dryrun':'tournament');
 expect(await a.reserve('first',6,8)).toBe(true);
 expect(await b.reserve('second',3,8)).toBe(false);
 expect(await b.reserve('second',1,8)).toBe(true);
 expect(await b.reserve('first',0.1,8)).toBe(false);
 expect(await a.entries()).toEqual([{id:'first',upperUsd:6,measuredUsd:null}]);
 expect(await b.entries()).toEqual([{id:'second',upperUsd:1,measuredUsd:null}]);
});
it('serializes competing dry and production admission against one combined cap',async()=>{
 const a=tournamentReservations(day,'tournament'),b=tournamentReservations(day,'tournament_dryrun');
 const admitted=await Promise.all([a.reserve('live',5,8),b.reserve('dry',5,8)]);
 expect(admitted.filter(Boolean)).toHaveLength(1);
});
it.each(['tournament','tournament_dryrun'] as const)('blocks both namespaces after an overrun in %s while preserving attribution',async(namespace)=>{
 const own=tournamentReservations(day,namespace),other=tournamentReservations(day,namespace==='tournament'?'tournament_dryrun':'tournament');
 await own.reserve('request',1,8);await own.measure('request',2);
 expect((await own.entries())[0].measuredUsd).toBe(2);expect(await other.entries()).toEqual([]);
 expect(await other.reserve('next',0.1,8)).toBe(false);
 expect(await own.reserve('next',0.1,8)).toBe(false);
});
it.each([NaN,-1,'bad',Infinity])('rejects corrupt persisted totals (%s) instead of bypassing the cap',async(reservedUsd)=>{
 state.docs.set(`tournamentBudget/tournament_dryrun_${day}`,{reservedUsd,entries:{}});
 await expect(tournamentReservations(day,'tournament').reserve('request',1,8)).rejects.toThrow(/Invalid persisted/);
});
it('exposes combined daily audit evidence without losing namespace attribution',async()=>{
 const live=tournamentReservations(day,'tournament'),dry=tournamentReservations(day,'tournament_dryrun');
 await live.reserve('live',3,8);await dry.reserve('dry',2,8);await dry.measure('dry',0.5);
 expect(await live.dailyEntries?.()).toEqual([{id:'live',upperUsd:3,measuredUsd:null},{id:'dry',upperUsd:2,measuredUsd:0.5}]);
 expect(await dry.entries()).toEqual([{id:'dry',upperUsd:2,measuredUsd:0.5}]);
});
