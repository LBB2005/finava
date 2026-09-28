// All tournament ledger writes live here. Create-only immutable rows, separately
// sealed daily batches, grades and portfolio marks; mutable locks never overwrite
// published data. Firestore rows are separate docs (20k rows exceed 1 MiB).
import { canonicalJson, hashEntry } from "./ledgerHash";
import { CHAIN_GENESIS } from "./ledgerCollections";
import type { Namespace, TournamentBatch, TournamentRow, TournamentGrade, PaperSnapshot, TournamentLedger } from "../tournament/types";
const sorted=(rows:TournamentRow[])=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));
export function makeBatch(rows:TournamentRow[],prior:TournamentBatch|null,meta:Pick<TournamentBatch,"date"|"asOf"|"createdAt"|"codeSha"|"registrationHash"|"snapshotHash"|"namespace">):TournamentBatch {
 const payload={date:meta.date,asOf:meta.asOf,createdAt:meta.createdAt,codeSha:meta.codeSha,registrationHash:meta.registrationHash,snapshotHash:meta.snapshotHash,namespace:meta.namespace,rowIds:sorted(rows).map(r=>r.id),previousDate:prior?.date??null};
 const previousHash=prior?.hash??CHAIN_GENESIS;
 return {...payload,previousHash,hash:hashEntry({...payload,rows:sorted(rows)},previousHash)};
}
export function verifyBatches(items:{batch:TournamentBatch;rows:TournamentRow[]}[]):{valid:boolean;reason:string|null} {
 let prior:TournamentBatch|null=null;
 for(const {batch,rows}of [...items].sort((a,b)=>a.batch.date.localeCompare(b.batch.date))){
  if(prior&&batch.date<=prior.date)return {valid:false,reason:"Duplicate or out-of-order day"};
  const expected=makeBatch(rows,prior,batch);
  if(canonicalJson(expected)!==canonicalJson(batch))return {valid:false,reason:`Hash chain mismatch on ${batch.date}`};
  prior=batch;
 }
 return {valid:true,reason:null};
}
function validateBatch(batch:TournamentBatch,rows:TournamentRow[],prior:TournamentBatch|null){
 if(!rows.length||new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error("Empty or duplicate prediction rows");
 if(prior&&batch.date<=prior.date)throw new Error("Cannot insert a past batch into the chain");
 if(canonicalJson(makeBatch(rows,prior,batch))!==canonicalJson(batch))throw new Error("Hash chain mismatch");
 for(const r of rows){
  const entry=r.prediction.evaluationWindow?.entryAt;
  if(!entry||Date.parse(r.prediction.createdAt)>=Date.parse(entry)||Date.parse(batch.createdAt)>=Date.parse(entry))throw new Error("Predictions must be sealed before entry open");
  if(r.id!==r.prediction.id||r.date!==batch.date||r.snapshotHash!==batch.snapshotHash||r.registrationHash!==batch.registrationHash||r.codeSha!==batch.codeSha||r.prediction.asOf!==batch.asOf)throw new Error("Prediction provenance does not match batch");
 }
}
export class MemoryTournamentLedger implements TournamentLedger {
 private batches=new Map<string,TournamentBatch>();private records=new Map<string,TournamentRow[]>();private marks=new Map<string,TournamentGrade>();private books=new Map<string,PaperSnapshot>();
 async listBatches(){return structuredClone([...this.batches.values()].sort((a,b)=>a.date.localeCompare(b.date)));}
 async rows(date:string){return structuredClone(this.records.get(date)??[]);}
 async appendBatch(batch:TournamentBatch,rows:TournamentRow[]){
  const previous=[...this.batches.values()].at(-1)??null;
  if(this.batches.has(batch.date)){if(canonicalJson(this.batches.get(batch.date))!==canonicalJson(batch)||canonicalJson(sorted(this.records.get(batch.date)!))!==canonicalJson(sorted(rows)))throw new Error("append-only conflict");return "duplicate" as const;}
  validateBatch(batch,rows,previous);this.batches.set(batch.date,structuredClone(batch));this.records.set(batch.date,structuredClone(rows));return "created" as const;
 }
 async grades(){return structuredClone([...this.marks.values()]);}
 async appendGrade(g:TournamentGrade){if(this.marks.has(g.id))throw new Error("append-only conflict");this.marks.set(g.id,structuredClone(g));}
 async portfolios(){return structuredClone([...this.books.values()]);}
 async appendPortfolio(p:PaperSnapshot){if(this.books.has(p.id))throw new Error("append-only conflict");this.books.set(p.id,structuredClone(p));}
 update():never{throw new Error("Tournament ledger is append-only");}
 delete():never{throw new Error("Tournament ledger is append-only");}
}
export async function firestoreTournamentLedger(namespace:Namespace):Promise<TournamentLedger>{
 const {db}=await import("../firebase-admin");
 const root=db.collection(namespace).doc("ledger");
 const createIdentical=async(collection:string,id:string,value:object)=>{
  const ref=root.collection(collection).doc(id);
  try{await ref.create(value);}catch(error){if((error as {code?:number}).code!==6)throw error;const existing=await ref.get();if(canonicalJson(existing.data())!==canonicalJson(value))throw new Error(`append-only conflict: ${collection}/${id}`);}
 };
 const ledger:TournamentLedger={
  async listBatches(){const s=await root.collection("batches").orderBy("date").get();return s.docs.map(d=>d.data() as TournamentBatch);},
  async rows(date){const s=await root.collection("predictions").where("date","==",date).get();return s.docs.map(d=>d.data() as TournamentRow);},
  async appendBatch(batch,rows){
   const batches=await ledger.listBatches(),existing=batches.find(b=>b.date===batch.date);
   if(existing){if(canonicalJson(existing)!==canonicalJson(batch)||canonicalJson(sorted(await ledger.rows(batch.date)))!==canonicalJson(sorted(rows)))throw new Error("append-only conflict");return "duplicate";}
   validateBatch(batch,rows,batches.at(-1)??null);
   // Unique per-day writers are serialized by the runtime lease. Retrying an
   // interrupted publication verifies each prior create before finishing.
   for(let i=0;i<rows.length;i+=100)await Promise.all(rows.slice(i,i+100).map(r=>createIdentical("predictions",r.id,r)));
   await db.runTransaction(async tx=>{
    const head=root.collection("state").doc("head"),snap=await tx.get(head);
    if((snap.data()?.hash??CHAIN_GENESIS)!==batch.previousHash)throw new Error("Concurrent batch changed chain head");
    tx.create(root.collection("batches").doc(batch.date),batch);
    tx.set(head,{date:batch.date,hash:batch.hash});
   });return "created";
  },
  async grades(){const s=await root.collection("grades").get();return s.docs.map(d=>d.data() as TournamentGrade);},
  async appendGrade(g){await createIdentical("grades",g.id,g);},
  async portfolios(){const s=await root.collection("portfolios").get();return s.docs.map(d=>d.data() as PaperSnapshot);},
  async appendPortfolio(p){await createIdentical("portfolios",p.id,p);},
 };return ledger;
}
