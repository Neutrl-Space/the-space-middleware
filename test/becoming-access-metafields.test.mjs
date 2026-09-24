import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncInterestMetafields } from '../lib/becoming-access-metafields.js';
const item = (variant = 'v1', title = 'Jersey') => ({product_id:'p1',product_handle:'jersey',product_title:title,variant_id:variant,variant_title:variant,selected_size:variant});
const submission = (id, items) => ({id,created_at:`2026-09-${id === 's1' ? '20' : '21'}T12:00:00Z`,campaign:'soho',becoming_access_interests:items});
function shopify() {
  let fields = null;
  return {
    get fields() { return fields; },
    graphql: async (q, v) => {
      if(q.includes('AccessPreferenceSnapshot')) return {customer:{snapshot:fields ? {value:fields[0].value,compareDigest:'a'} : null,summary:fields ? {compareDigest:'b'} : null}};
      fields = v.metafields; return {metafieldsSet:{userErrors:[]}};
    },
  };
}
test('writes both fields atomically, including multiple sizes and no-variant products',async()=>{
 const api=shopify();
 await syncInterestMetafields('c1',submission('s1',[item(),item('v2'),{product_id:'p2',product_title:'Hat',variant_id:null}]),api.graphql);
 assert.equal(api.fields.length,2);assert(api.fields.every(f=>f.ownerId==='c1' && f.compareDigest===null));
 assert.equal(JSON.parse(api.fields[0].value).interests.length,3);
 assert.match(api.fields[1].value,/Jersey — v1 \(size: v1\)/);assert.match(api.fields[1].value,/\nHat$/);
});
test('repeat submissions add sizes without removing earlier selections or duplicating repeats',async()=>{
 const api=shopify();
 await syncInterestMetafields('c1',submission('s1',[item()]),api.graphql);
 await syncInterestMetafields('c1',submission('s2',[item(),item('v2')]),api.graphql);
 await syncInterestMetafields('c1',submission('s2',[item(),item('v2')]),api.graphql);
 const data=JSON.parse(api.fields[0].value);
 assert.equal(data.interests.length,2);assert.equal(data.submissionId,'s2');
 assert.equal(api.fields[0].compareDigest,'a');assert.equal(api.fields[1].compareDigest,'b');
});
test('older retries add missing interests while retaining newer titles and date',async()=>{
 const api=shopify();
 await syncInterestMetafields('c1',submission('s2',[item('v2','New title')]),api.graphql);
 await syncInterestMetafields('c1',submission('s1',[item(),item('v2','Old title')]),api.graphql);
 const data=JSON.parse(api.fields[0].value);
 assert.equal(data.submissionId,'s2');assert.equal(data.interests.length,2);
 assert.equal(data.interests[1].productTitle,'New title');
});
test('concurrent conflict re-reads and merges the winning submission',async()=>{
 const api=shopify();let writes=0;
 await syncInterestMetafields('c1',submission('s1',[item()]),async(q,v)=>{
  if(!q.includes('AccessPreferenceSnapshot') && ++writes===1){
   await syncInterestMetafields('c1',submission('s2',[item('v2')]),api.graphql);
   return {metafieldsSet:{userErrors:[{code:'INVALID_COMPARE_DIGEST'}]}};
  }
  return api.graphql(q,v);
 });
 const data=JSON.parse(api.fields[0].value);assert.equal(writes,2);assert.equal(data.interests.length,2);assert.equal(data.submissionId,'s2');
});
test('API failures, exhausted conflicts and malformed snapshots fail without erasing preferences',async()=>{
 for(const code of ['INVALID_TYPE','INVALID_COMPARE_DIGEST']) await assert.rejects(()=>syncInterestMetafields('c1',submission('s1',[item()]),async(q)=>q.includes('AccessPreferenceSnapshot')?{customer:{snapshot:null}}:{metafieldsSet:{userErrors:[{code}]}}));
 await assert.rejects(()=>syncInterestMetafields('c1',submission('s1',[]),async()=>{}));
 await assert.rejects(()=>syncInterestMetafields('c1',submission('s1',[item()]),async()=>({customer:{snapshot:{value:'{}'}}})));
});
