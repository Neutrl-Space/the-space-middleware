import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOptin, subscribeOptin, createOptinHandler} from '../lib/becoming-optin.js';
import {updateSmsConsent} from '../lib/marketing-consent.js';
const input={email:' GUEST@example.com ',emailConsent:true,smsConsent:false,phone:'+12125551234'};
function fake({exists=true,phone=null,fail=null,race=false,unverified=false}={}) {
 const calls=[];
 const graphql=async(q,v)=>{
  calls.push({q,v});
  if(q.includes('customers(first'))return {customers:{nodes:exists||(race&&calls.length>2)?[{id:'c',email:'guest@example.com',phone}]:[]}};
  if(q.includes('VerifyBecomingSmsConsent'))return {customer:{phone:'+12125551234',smsMarketingConsent:{marketingState:unverified?'NOT_SUBSCRIBED':'SUBSCRIBED'}}};
  if(q.includes('VerifyBecomingOptin'))return {customer:{tags:unverified?[]:['becoming:optin'],emailMarketingConsent:{marketingState:'SUBSCRIBED'},smsMarketingConsent:{marketingState:'SUBSCRIBED'}}};
  const field=['customerCreate','customerUpdate','customerEmailMarketingConsentUpdate','customerSmsMarketingConsentUpdate','tagsAdd'].find(f=>q.includes(f+'('));
  return {[field]:{customer:{id:'c',phone},node:{id:'c'},userErrors:field===fail||(race&&field==='customerCreate')?[{message:'Failed'}]:[]}};
 };return {graphql,calls};
}
test('requires explicit boolean consent and international SMS number',()=>{
 assert.deepEqual(validateOptin(input),{email:'guest@example.com',smsConsent:false,phone:''});
 assert.equal(validateOptin({...input,smsConsent:true,phone:'+1 (212) 555-1234'}).phone,'+12125551234');
 for(const change of [{emailConsent:false},{emailConsent:'true'},{smsConsent:'true'},{email:'bad'},{smsConsent:true,phone:'2125551234'},{website:'spam'}])assert.throws(()=>validateOptin({...input,...change}));
});
test('existing email is reused, email subscribed and tag added, with SMS left alone',async()=>{
 const f=fake();await subscribeOptin(validateOptin(input),f.graphql);
 assert.equal(f.calls.length,4);assert.equal(f.calls[1].v.input.emailMarketingConsent.marketingState,'SUBSCRIBED');
 assert.deepEqual(f.calls[2].v.tags,['becoming:optin']);
 assert.ok(!f.calls.some(c=>c.q.includes('customerCreate(')||c.q.includes('customerUpdate(')||c.q.includes('customerSmsMarketingConsentUpdate(')));
});
test('new subscriber receives phone and both confirmed consents',async()=>{
 const f=fake({exists:false});await subscribeOptin(validateOptin({...input,smsConsent:true}),f.graphql);
 assert.equal(f.calls[1].v.input.email,'guest@example.com');assert.equal(f.calls[2].v.input.phone,'+12125551234');
 assert.ok(f.calls.some(c=>c.v.input?.smsMarketingConsent?.marketingState==='SUBSCRIBED'));
});
test('concurrent creation reuses the existing email instead of creating another customer',async()=>{
 const f=fake({exists:false,race:true});assert.equal(await subscribeOptin(validateOptin(input),f.graphql),'c');
});
test('existing matching phone is preserved and different phone is rejected',async()=>{
 const f=fake({phone:'+12125551234'});await subscribeOptin(validateOptin({...input,smsConsent:true}),f.graphql);
 assert.ok(!f.calls.some(c=>c.q.includes('customerUpdate(')));
 const conflict=fake({phone:'+12125559999'});await assert.rejects(subscribeOptin(validateOptin({...input,smsConsent:true}),conflict.graphql),e=>e.statusCode===409);assert.equal(conflict.calls.length,1);
});
test('mutation failures and failed verification never report signup success',async()=>{
 for(const fail of ['customerEmailMarketingConsentUpdate','customerSmsMarketingConsentUpdate','tagsAdd']){
  const f=fake({fail});await assert.rejects(subscribeOptin(validateOptin({...input,smsConsent:true}),f.graphql));
 }
 const f=fake({unverified:true});await assert.rejects(subscribeOptin(validateOptin(input),f.graphql));
 await assert.rejects(subscribeOptin(validateOptin({...input,smsConsent:true}),f.graphql));
});
test('shared SMS helper does nothing without explicit consent',async()=>{
 let calls=0;await updateSmsConsent({id:'c'},{phone:'+12125551234',smsConsent:false},async()=>{calls++});assert.equal(calls,0);
});
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(v){this.body=v;return this},end(){return this}}}
test('handler enforces origin, method, size and JSON; returns only confirmed success',async()=>{
 const f=fake();const handler=createOptinHandler({graphql:f.graphql,env:{POPUP_ALLOWED_ORIGINS:'https://neutrlspace.com'}});
 const request={method:'POST',headers:{origin:'https://neutrlspace.com','content-type':'application/json'},body:input};
 for(const [change,code] of [[{headers:{origin:'https://bad.example'}},403],[{method:'GET'},405],[{body:'x'.repeat(4097)},413],[{body:'invalid json'},400],[{headers:{...request.headers,'content-type':'text/plain'}},415],[{method:'OPTIONS'},204]]){
  const res=response();await handler({...request,...change},res);assert.equal(res.code,code);
 }
 const res=response();await handler(request,res);assert.equal(res.code,200);assert.deepEqual(res.body,{success:true});
});
