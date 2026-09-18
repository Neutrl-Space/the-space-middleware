import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Readable} from 'node:stream';
import {createCancellationHandler} from '../lib/popup-cancellation.mjs';
const env = {SHOPIFY_CLIENT_SECRET:'test-secret', SHOPIFY_SHOP:'test-store'};
const payload = {admin_graphql_api_id:'gid://shopify/Order/123',cancelled_at:'2026-09-16T15:30:00-04:00',tags:'SOHO_POPUP, QR_RESERVATION'};
function setup(row = {id:'row1',shopify_order_id:payload.admin_graphql_api_id,status:'received',paid_at:null}) {
  let updates=0, calls=0, fail=false;
  const supabase={from(table){
    calls++; assert.equal(table,'event_orders');
    let values, orderId, excluded;
    const query={update(v){values=v;return this;},eq(k,v){assert.equal(k,'shopify_order_id');orderId=v;return this;},neq(k,v){assert.equal(k,'status');excluded=v;return this;},
      select(){if(!values)return this; if(fail)return Promise.resolve({error:{message:'offline'}}); const matches=row && row.shopify_order_id===orderId && row.status!==excluded;if(matches){Object.assign(row,values);updates++;}return Promise.resolve({data:matches?[{id:row.id}]:[]});},
      async maybeSingle(){return {data:row?.shopify_order_id===orderId?{id:row.id}:null};}};
    return query;
  }};
  const handler=createCancellationHandler({supabase,env,logger:{error(){}}});
  async function send(body=payload,headers={},method='POST') {
    const raw=typeof body==='string'?body:JSON.stringify(body);
    const req=Readable.from([Buffer.from(raw)]);req.method=method;
    req.headers={'x-shopify-hmac-sha256':createHmac('sha256',env.SHOPIFY_CLIENT_SECRET).update(raw).digest('base64'),'x-shopify-shop-domain':'test-store.myshopify.com','x-shopify-topic':'orders/cancelled',...headers};
    // A parsed/reformatted body must never be used to verify the signature.
    req.body={untrusted:'different JSON'};
    const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler(req,res);return res;
  }
  return {send,row,get updates(){return updates;},get calls(){return calls;},fail(){fail=true;}};
}
test('verified cancellation updates the matching record and preserves workflow history',async()=>{
 const ctx=setup();assert.equal((await ctx.send()).code,200);assert.equal(ctx.row.status,'cancelled');assert.equal(ctx.row.cancelled_at,'2026-09-16T19:30:00.000Z');assert.equal(ctx.row.paid_at,null);assert.equal(ctx.updates,1);
 const updated=ctx.row.updated_at;await ctx.send();assert.equal(ctx.updates,1);assert.equal(ctx.row.updated_at,updated);
});
test('forged signature, wrong shop/topic and wrong method cannot write',async()=>{
 for(const [headers,method,status] of [[{'x-shopify-hmac-sha256':'A'.repeat(43)+'='},'POST',401],[{'x-shopify-shop-domain':'other.myshopify.com'},'POST',403],[{'x-shopify-topic':'orders/create'},'POST',400],[{},'GET',405]]) {
 const ctx=setup();assert.equal((await ctx.send(payload,headers,method)).code,status);assert.equal(ctx.calls,0);
 }
});
test('malformed JSON and missing cancellation date are rejected',async()=>{
 const ctx=setup();assert.equal((await ctx.send('{')).code,400);assert.equal((await ctx.send({...payload,cancelled_at:null})).code,400);assert.equal(ctx.calls,0);
});
test('missing ordinary order is ignored; missing pop-up order is retried',async()=>{
 const ctx=setup(null);assert.equal((await ctx.send({...payload,tags:''})).code,200);assert.equal((await ctx.send()).code,503);
});
test('early delivery succeeds when Shopify retries after insertion',async()=>{
 const row={id:'r',shopify_order_id:'not-yet',status:'received'};const ctx=setup(row);
 assert.equal((await ctx.send()).code,503);row.shopify_order_id=payload.admin_graphql_api_id;
 assert.equal((await ctx.send()).code,200);assert.equal(row.status,'cancelled');
});
test('database failures return a retryable error',async()=>{
 const ctx=setup();ctx.fail();assert.equal((await ctx.send()).code,503);assert.equal(ctx.updates,0);
});
test('numeric order ID fallback matches stored Shopify GID',async()=>{
 const ctx=setup();assert.equal((await ctx.send({...payload,admin_graphql_api_id:undefined,id:123})).code,200);assert.equal(ctx.row.status,'cancelled');
});
