import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { validatePayload, verifyInterests, syncCustomer, createBecomingAccessHandler, synchronizeSubmission } from '../lib/becoming-access.js';
const P = 'gid://shopify/Product/1', V = 'gid://shopify/ProductVariant/2';
const body = () => ({name:' Test Person ',email:'TEST@example.com',phone:'',marketingConsent:false,
  interests:[{productId:P,variantId:V,productTitle:'Fabricated',selectedSize:'Fabricated'}],attribution:{utmSource:'soho_popup',utmContent:'rack'}});
const catalog = async (query) => query.includes('AccessCollection') ? {collectionByIdentifier:{id:'collection'}} : {nodes:[
  {id:P,title:'Real Jersey',handle:'real-jersey',inCollection:true,hasOnlyDefaultVariant:false},
  {id:V,title:'Medium / Blue',product:{id:P},selectedOptions:[{name:'Size',value:'M'}]},
]};
const env={POPUP_ALLOWED_ORIGINS:'https://neutrlspaceny.com',BECOMING_ACCESS_COLLECTION_HANDLE:'soho-pop-up-september-2026'};
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(v){this.code=v;return this;},json(v){this.body=v;return this;},end(){return this;}};}
function database({saveError=false,updateError=false}={}) {
 const updates=[]; let saved;
 return {updates,get saved(){return saved;}, async rpc(name,args){assert.equal(name,'save_becoming_access_request');saved=args.request_data;return saveError?{error:{}}:{data:{submission_id:'submission',contact_id:'contact'}};},
  from(table){return {update(value){return {async eq(k,id){updates.push({table,value,id});return {error:updateError?{}:null};}};}};}};
}
function customerGraphql({exists=true,fail=false}={}) {
 const calls=[];
 const fn=async(q,v)=>{calls.push({q,v});if(fail)throw Error('Unavailable');
 if(q.includes('AccessCollection')||q.includes('AccessSelections'))return catalog(q,v);
 if(q.includes('query AccessCustomer'))return {customers:{nodes:exists?[{id:'customer',email:'test@example.com'}]:[]}};
 const key=q.includes('CreateAccessCustomer')?'customerCreate':q.includes('UpdateAccessCustomer')?'customerUpdate':q.includes('TagAccessCustomer')?'tagsAdd':'customerEmailMarketingConsentUpdate';
 return {[key]:{customer:{id:'customer'},node:{id:'customer'},userErrors:[]}};};fn.calls=calls;return fn;
}
test('normalization, ID validation, duplicate/empty selections, and boolean consent',()=>{
 const valid=validatePayload(body());assert.equal(valid.email,'test@example.com');assert.equal(valid.name,'Test Person');
 assert.equal(validatePayload({...body(),interests:[{productId:'1',variantId:'2'}]}).interests[0].productId,P);
 for(const bad of [{name:''},{email:'bad'},{interests:[]},{interests:[...body().interests,...body().interests]},{marketingConsent:'true'},{interests:[{productId:123}]},{interests:Array(101).fill({productId:P})}])assert.throws(()=>validatePayload({...body(),...bad}));
});
test('canonical Shopify metadata replaces browser names and validates membership and variant ownership',async()=>{
 const result=await verifyInterests(validatePayload(body()).interests,catalog,env.BECOMING_ACCESS_COLLECTION_HANDLE);
 assert.equal(result[0].productTitle,'Real Jersey');assert.equal(result[0].selectedSize,'M');
 for(const change of ['outside','wrong-variant','missing']){
  const graphql=async(q)=>{const data=await catalog(q);if(data.nodes){if(change==='outside')data.nodes[0].inCollection=false;if(change==='wrong-variant')data.nodes[1].product.id='other';if(change==='missing')data.nodes[1]=null;}return data;};
  await assert.rejects(()=>verifyInterests(validatePayload(body()).interests,graphql,'handle'));
 }
 await assert.rejects(()=>verifyInterests([{productId:P,variantId:null}],catalog,'handle'));
 const noSizes=async(q)=>{const data=await catalog(q);if(data.nodes)data.nodes[0].hasOnlyDefaultVariant=true;return data;};
 assert.equal((await verifyInterests([{productId:P,variantId:null}],noSizes,'handle'))[0].variantTitle,null);
});
test('existing customer tags are added, no marketing mutation without opt-in',async()=>{
 const graphql=customerGraphql();assert.equal(await syncCustomer({...validatePayload(body()),consentUpdatedAt:'2026-09-20T00:00:00Z'},graphql,['becoming-access']),'customer');
 assert(graphql.calls.some(c=>c.q.includes('tagsAdd')));assert(!graphql.calls.some(c=>c.q.includes('AccessMarketingConsent')));
 assert(!graphql.calls.find(c=>c.q.includes('UpdateAccessCustomer')).v.input.tags);
});
test('new customer and explicit marketing opt-in are separate mutations',async()=>{
 const graphql=customerGraphql({exists:false});await syncCustomer({...validatePayload(body()),marketingConsent:true,consentUpdatedAt:'2026-09-20T00:00:00Z'},graphql,['becoming-access']);
 assert(graphql.calls.some(c=>c.q.includes('CreateAccessCustomer')));assert(graphql.calls.some(c=>c.q.includes('AccessMarketingConsent')));
});
async function request({db=database(),graphql=customerGraphql(),method='POST',origin='https://neutrlspaceny.com',payload=body(),contentType='application/json'}={}){
 const res=response();await createBecomingAccessHandler({db,graphql,env})({method,headers:{origin,'content-type':contentType},body:payload},res);return {res,db,graphql};
}
test('allowed origin preflight, untrusted/missing origins, method, and JSON restrictions',async()=>{
 assert.equal((await request({method:'OPTIONS'})).res.code,204);
 for(const origin of ['https://evil.example','', 'https://neutrlspaceny.com.evil.example'])assert.equal((await request({origin})).res.code,403);
 assert.equal((await request({method:'GET'})).res.code,405);assert.equal((await request({contentType:'text/plain'})).res.code,415);
 assert.equal((await request({payload:'{'})).res.code,400);assert.equal((await request({payload:'x'.repeat(65537)})).res.code,413);
});
test('save precedes Shopify customer sync; all interests persist in one RPC',async()=>{
 const db=database(),graphql=customerGraphql();const wrapped=async(q,v)=>{if(q.includes('AccessCustomer'))assert(db.saved);return graphql(q,v);};
 const {res}=await request({db,graphql:wrapped});assert.equal(res.code,200);assert(res.body.success);assert.equal(db.saved.interests[0].productTitle,'Real Jersey');assert(db.updates.some(u=>u.value.shopify_sync_status==='synced'));
});
test('database failure prevents customer sync and success',async()=>{
 const graphql=customerGraphql();const {res}=await request({db:database({saveError:true}),graphql});assert.equal(res.code,503);assert(!graphql.calls.some(c=>c.q.includes('AccessCustomer')));
});
test('Shopify sync failure retains saved request, records failed state, and returns success',async()=>{
 const db=database();const graphql=async(q,v)=>{if(q.includes('AccessCustomer'))throw Error('private upstream details');return catalog(q,v);};
 const {res}=await request({db,graphql});assert.equal(res.code,200);assert(res.body.success);assert(db.saved);assert(db.updates.some(u=>u.value.shopify_sync_status==='failed'));
});
test('failed synchronization can retry without inserting another submission',async()=>{
 const db=database();const record={id:'s',contact_id:'c',shopify_sync_payload:{...validatePayload(body()),consentUpdatedAt:'2026-09-20T00:00:00Z'}};
 assert(await synchronizeSubmission(db,customerGraphql(),record,['becoming-access']));assert.equal(db.saved,undefined);
});
test('raw request stream is parsed',async()=>{
 const req=Readable.from([JSON.stringify(body())]);req.method='POST';req.headers={origin:'https://neutrlspaceny.com','content-type':'application/json'};
 const res=response();await createBecomingAccessHandler({db:database(),graphql:customerGraphql(),env})(req,res);assert.equal(res.code,200);
});
test('multiple sizes retain separate canonical interests',async()=>{
 const second='gid://shopify/ProductVariant/3';
 const graphql=async(q)=>{const data=await catalog(q);if(data.nodes)data.nodes.push({id:second,title:'Large',product:{id:P},selectedOptions:[{name:'Size',value:'L'}]});return data;};
 const interests=await verifyInterests([{productId:P,variantId:V},{productId:P,variantId:second}],graphql,'handle');
 assert.deepEqual(interests.map(i=>i.selectedSize),['M','L']);
});
test('catalog outage prevents persistence',async()=>{
 const db=database();const {res}=await request({db,graphql:async()=>{throw Error('Shopify unavailable');}});assert.equal(res.code,503);assert.equal(db.saved,undefined);
});
test('raw UTF-8 body supports chunk boundaries inside customer names',async()=>{
 const payload={...body(),name:'Renée'};const bytes=Buffer.from(JSON.stringify(payload));const boundary=bytes.indexOf(Buffer.from('é'))+1;
 const req=Readable.from([bytes.subarray(0,boundary),bytes.subarray(boundary)]);req.method='POST';req.headers={origin:'https://neutrlspaceny.com','content-type':'application/json'};
 const db=database(),res=response();await createBecomingAccessHandler({db,graphql:customerGraphql(),env})(req,res);assert.equal(db.saved.name,'Renée');assert.equal(res.code,200);
});
