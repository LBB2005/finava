import {it,expect} from 'vitest';
import {emptyInputs} from '../facts/pointInTime';
import {attachReferenceValuation} from './liveValuation';
const asOf='2026-09-28T20:00:00.000Z';
const fundamentals={inputs:emptyInputs(),revenue:1000,netIncome:100,revenuePeriod:"2025-07-01/2026-06-30",netIncomePeriod:"2025-07-01/2026-06-30",shares:{shares:10,asOf:'2026-08-01'}};
const member={ticker:'BRK.B',cik:'0001067983'};
const raw={status:'OK',results:{ticker:'BRK.B',cik:'0001067983',currency_name:'usd',weighted_shares_outstanding:150,share_class_shares_outstanding:10,market_cap:3000}};
it('values the issuer using dated class-equivalent shares, never class-only SEC shares',()=>{
 const inputs=emptyInputs();inputs.price={value:20,asOf,source:'SIP'};
 const result=attachReferenceValuation(inputs,fundamentals,raw,member,asOf);
 expect(result.peTTM.value).toBe(30);expect(result.psTTM.value).toBe(3);
 expect(result.peTTM.url).toContain('date=2026-09-27');
 expect(result.peTTM.note).toContain('class-equivalent');
 expect(result.peTTM.period).toBe('2025-07-01/2026-06-30');
 expect(result.peTTM.note).toContain('90 days');
});
it('withholds ambiguous, wrong-issuer, foreign-currency or missing reference valuation',()=>{
 for(const results of [{...raw.results,cik:'999'},{...raw.results,ticker:'OTHER'},{...raw.results,currency_name:'eur'},{...raw.results,weighted_shares_outstanding:undefined}]){
  const inputs=emptyInputs();inputs.price={value:20,asOf,source:'SIP'};inputs.peTTM={value:2,asOf,source:'unsafe cover-page shares'};
  expect(attachReferenceValuation(inputs,fundamentals,{status:'OK',results},member,asOf).peTTM.value).toBeNull();
 }
});
it('requires a matching dated SIP close and positive matched denominators',()=>{
 const inputs=emptyInputs();inputs.price={value:20,asOf:'2026-09-25T20:00:00.000Z',source:'SIP'};
 expect(attachReferenceValuation(inputs,fundamentals,raw,member,asOf).peTTM.value).toBeNull();
 inputs.price.asOf=asOf;
 const result=attachReferenceValuation(inputs,{...fundamentals,netIncome:-1,revenue:null},raw,member,asOf);
 expect(result.peTTM.value).toBeNull();expect(result.psTTM.value).toBeNull();
});

it.each([2,0.1,1.05])('converts prior-date reference shares by only the scoring-day factor %s',factor=>{
 const inputs=emptyInputs();inputs.price={value:20,asOf,source:'SIP'};
 const splits=[{date:'2026-09-27',factor:10},{date:'2026-09-28',factor},{date:'2026-09-29',factor:99}];
 const result=attachReferenceValuation(inputs,fundamentals,raw,member,asOf,splits);
 expect(result.peTTM.value).toBeCloseTo(30*factor);
 expect(result.peTTM.note).toContain('reference date 2026-09-27');
 expect(result.peTTM.note).toContain('share-basis factor '+factor);
});
it('withholds valuation when current-day share-basis continuity is unknown or invalid',()=>{
 const inputs=emptyInputs();inputs.price={value:20,asOf,source:'SIP'};
 expect(attachReferenceValuation(inputs,fundamentals,raw,member,asOf,null).peTTM.value).toBeNull();
 expect(attachReferenceValuation(inputs,fundamentals,raw,member,asOf,[{date:'2026-09-28',factor:0}]).peTTM.value).toBeNull();
});
