import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncInterestMetafields } from '../lib/becoming-access-metafields.js';
const submission = {id:'s1',created_at:'2026-09-20T12:00:00Z',campaign:'soho',becoming_access_interests:[
  {product_id:'p1',product_handle:'jersey',product_title:'Jersey',variant_id:'v1',variant_title:'Medium / Blue',selected_size:'M'},
  {product_id:'p1',product_handle:'jersey',product_title:'Jersey',variant_id:'v2',variant_title:'Large / Blue',selected_size:'L'},
  {product_id:'p2',product_handle:'hat',product_title:'Hat',variant_id:null,variant_title:null,selected_size:null},
]};
test('stores readable summary and structured preferences atomically, including multiple sizes and a hat',async()=>{
 let fields;
 await syncInterestMetafields('c1',submission,async(q,v)=>{
  if(q.includes('AccessPreferenceSnapshot'))return {customer:{snapshot:null,summary:null}};
  fields=v.metafields;return {metafieldsSet:{userErrors:[]}};
 });
 assert.equal(fields.length,2);assert(fields.every(f=>f.ownerId==='c1'&&f.compareDigest===null));
 const snapshot=JSON.parse(fields[0].value);assert.equal(snapshot.interests.length,3);assert.equal(snapshot.interests[2].variantId,null);
 assert.match(fields[1].value,/Jersey — Medium \/ Blue \(size: M\)/);assert.match(fields[1].value,/Jersey — Large \/ Blue \(size: L\)/);assert.match(fields[1].value,/\nHat$/);
});
test('older retries cannot overwrite a newer snapshot',async()=>{
 let writes=0;
 await syncInterestMetafields('c1',submission,async(q)=>{
  if(q.includes('AccessPreferenceSnapshot'))return {customer:{snapshot:{value:JSON.stringify({submissionId:'s2',submittedAt:'2026-09-21T00:00:00Z'})}}};
  writes++;throw Error('Unexpected write');
 });assert.equal(writes,0);
});
test('concurrent write conflict re-reads and skips if the winner is newer',async()=>{
 let reads=0,writes=0;
 await syncInterestMetafields('c1',submission,async(q)=>{
  if(q.includes('AccessPreferenceSnapshot')){reads++;return reads===1?{customer:{snapshot:null,summary:null}}:{customer:{snapshot:{value:JSON.stringify({submissionId:'s2',submittedAt:'2026-09-21T00:00:00Z'})}}};}
  writes++;return {metafieldsSet:{userErrors:[{code:'INVALID_COMPARE_DIGEST'}]}};
 });assert.equal(reads,2);assert.equal(writes,1);
});
test('same-submission retries use both digests and do not append duplicate entries',async()=>{
 let fields;
 await syncInterestMetafields('c1',submission,async(q,v)=>{
  if(q.includes('AccessPreferenceSnapshot'))return {customer:{snapshot:{value:JSON.stringify({submissionId:'s1',submittedAt:submission.created_at}),compareDigest:'a'},summary:{compareDigest:'b'}}};
  fields=v.metafields;return {metafieldsSet:{userErrors:[]}};
 });assert.equal(fields[0].compareDigest,'a');assert.equal(fields[1].compareDigest,'b');assert.equal(JSON.parse(fields[0].value).interests.length,3);
});
test('metafield API errors and missing saved preferences fail synchronization',async()=>{
 await assert.rejects(()=>syncInterestMetafields('c1',submission,async(q)=>q.includes('AccessPreferenceSnapshot')?{customer:{snapshot:null}}:{metafieldsSet:{userErrors:[{code:'INVALID_TYPE'}]}}));
 await assert.rejects(()=>syncInterestMetafields('c1',{...submission,becoming_access_interests:[]},async()=>{}));
});
