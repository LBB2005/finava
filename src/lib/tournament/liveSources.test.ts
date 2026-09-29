import { it, expect } from "vitest";
import { createTournamentSources } from "./liveSources";
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureSnapshot } from './fixtures';
const calendar={range:async()=>[{date:'2026-07-02',open:'2026-07-02T13:30:00.000Z',close:'2026-07-02T20:00:00.000Z'}]};
it('keeps an explicitly configured evidence archive authoritative',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'tournament-source-'));
 try{
  await mkdir(join(directory,'snapshots'));const s=fixtureSnapshot();s.evidenceClass='prospective';
  await writeFile(join(directory,'snapshots/2026-07-02.json'),JSON.stringify(s));
  const source=createTournamentSources(calendar,'2026-07-02',{TOURNAMENT_DATA_DIR:directory});
  expect((await source.snapshot('2026-07-02')).names).toHaveLength(30);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('keeps missing market marks unknown instead of inventing a no-action day',async()=>{
 const source=createTournamentSources(calendar,'2026-07-02',{},async()=>{throw new Error('provider unavailable');});
 expect(await source.mark('AAPL','2026-07-02')).toMatchObject({open:null,close:null,splitFactor:null,cashPerPreviousShare:null,actionsComplete:false});
});
it('collects a real market mark through live sources when no archive is configured',async()=>{
 const get=async(url:string)=>{
  if(url.includes('corporate-actions'))return {corporate_actions:{},next_page_token:null};
  if(url.includes('/assets/'))return {symbol:'AAPL',class:'us_equity',exchange:'NASDAQ'};
  if(url.includes('/trades?'))return {symbol:'AAPL',trades:[{t:'2026-07-02T13:30:00.000Z',p:100,x:'Q',c:['Q'],i:1}],next_page_token:null};
  return {symbol:'AAPL',bars:[{t:'2026-07-02T04:00:00.000Z',c:101}],next_page_token:null};
 };
 const source=createTournamentSources(calendar,'2026-07-02',{},get);
 expect(await source.mark('AAPL','2026-07-02')).toMatchObject({open:100,close:101,splitFactor:1,cashPerPreviousShare:0,actionsComplete:true});
});
