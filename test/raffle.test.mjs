import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRaffleHandler } from '../lib/raffle.js';
const payload = {name:'  Guest Name  ',eventId:'soho-popup-2026',requestId:'e6c76a20-199b-4cf8-a010-c1bf899fd45a'};
const env={POPUP_ALLOWED_ORIGINS:'https://neutrlspaceny.com',RAFFLE_EVENT_ID:'soho-popup-2026',RAFFLE_ENTRIES_OPEN:'true'};
async function send(options={}) {
 const calls=[];
 const db={rpc:async(fn,args)=>{calls.push(args);assert.equal(fn,'register_raffle_entry');return options.rpc?options.rpc(args,calls.length):{data:{name:args.p_name,number:args.p_number}};}};
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(value){this.value=value;return this;},end(){return this;}};
 await createRaffleHandler({db,env:{...env,...options.env},number:()=>123456})({method:options.method||'POST',headers:{origin:options.origin??'https://neutrlspaceny.com','content-type':options.contentType||'application/json'},body:options.body??payload},res);
 return {res,calls};
}
test('name and server number are saved before confirmation',async()=>{
 const {res,calls}=await send();assert.equal(res.code,200);assert.deepEqual(res.value.entry,{name:'Guest Name',number:123456});assert.equal(calls[0].p_request_id,payload.requestId);
});
test('database number collision retries',async()=>{
 const {res,calls}=await send({rpc:(args,n)=>n===1?{error:{code:'23505'}}:{data:{name:args.p_name,number:654321}}});assert.equal(calls.length,2);assert.equal(res.value.entry.number,654321);
});
test('retry returns original stored name and number',async()=>{
 const {res}=await send({body:{...payload,name:'Changed name'},rpc:()=>({data:{name:'Original name',number:777777}})});assert.deepEqual(res.value.entry,{name:'Original name',number:777777});
});
test('invalid fields never reach storage',async()=>{
 for(const body of [{...payload,name:''},{...payload,name:'x'.repeat(121)},{...payload,eventId:'other'},{...payload,requestId:'bad'},'{']){
  const {res,calls}=await send({body});assert.equal(res.code,400);assert.equal(calls.length,0);
 }
});
test('CORS, method and content type checks',async()=>{
 assert.equal((await send({origin:'https://evil.example'})).res.code,403);
 assert.equal((await send({method:'OPTIONS'})).res.code,204);
 assert.equal((await send({method:'GET'})).res.code,405);
 assert.equal((await send({contentType:'text/plain'})).res.code,415);
 assert.equal((await send({body:'x'.repeat(4097)})).res.code,413);
});
test('closed or unconfigured event cannot issue entries',async()=>{
 for(const config of [{RAFFLE_ENTRIES_OPEN:'false'},{RAFFLE_EVENT_ID:''}]){const {res,calls}=await send({env:config});assert.equal(res.code,503);assert.equal(calls.length,0);}
});
test('storage failure or exhausted collisions never reports success',async()=>{
 const failed=await send({rpc:()=>({error:{code:'database-failed'}})});assert.equal(failed.res.code,503);assert.equal(failed.calls.length,1);
 const collisions=await send({rpc:()=>({error:{code:'23505'}})});assert.equal(collisions.res.code,503);assert.equal(collisions.calls.length,20);
});
