import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createReservationService, ReservationError, validateReservation} from '../lib/popup-reservations.mjs';
import {createPopupShopify} from '../lib/popup-shopify.mjs';
import {sendPopupSms} from '../lib/popup-sms.mjs';

const input = () => ({requestId: randomUUID(), productId: '123', variantId: '456', quantity: 1, name: 'Test Guest', phone: '+12125551234', email: '', smsConsent: true, source: 'soho-popup-qr'});
function setup({stock = 1, failure, smsFailure = false, smsDeferred = false} = {}) {
  const requests = new Map(), events = new Map(), orders = new Map();
  let smsCount = 0;
  const store = {
    async claim(body, fingerprint) {
      if (requests.has(body.requestId)) return {owner:false, record:requests.get(body.requestId)};
      const record = {fingerprint, created_at: new Date().toISOString(), status:'processing', reservation_code: `NS-${String(requests.size + 1).padStart(4, '0')}`};
      requests.set(body.requestId, record); return {owner:true, record};
    },
    async updateRequest(id, values) { Object.assign(requests.get(id), structuredClone(values)); },
    async createEvent(values) { if (failure === 'store') throw new Error('DB offline'); events.set(values.shopify_order_id, values); },
  };
  const shopify = {
    async validateVariant(body) {
      if (stock < body.quantity) throw new ReservationError(409,'VARIANT_SOLD_OUT','This size has just sold out.');
      return {product:{title:'Piece'}, title:'Medium'};
    },
    async createOrder(body) {
      // Emulate Shopify's atomic policy-enforced claim. Both requests may pass the earlier read.
      if (stock < body.quantity) throw new ReservationError(409,'VARIANT_SOLD_OUT','This size has just sold out.');
      stock -= body.quantity;
      assert.match(body.reservationCode, /^NS-\d{4,}$/);
      const order = {id:`gid://shopify/Order/${orders.size + 1}`, name:`#${orders.size + 1}`};
      orders.set(body.requestId,order);
      if (failure === 'timeout') throw new Error('Response lost after order created');
      return order;
    },
    async verifyOrder() { if (failure === 'verify') throw new Error('Commit not visible'); return {committed:1}; },
  };
  const reserve = createReservationService({store, shopify, sendSms:smsDeferred ? null : async () => {smsCount++; if(smsFailure) throw new Error('SMS down'); return {id:'SM123'};}, logger:{error(){}}});
  return {reserve,requests,events,orders, get smsCount(){return smsCount}};
}

test('validates IDs, quantity, SMS consent, name, phone and optional email', () => {
  assert.equal(validateReservation(input()).email,'');
  for (const override of [{variantId:'Large'},{variantId:9007199254740992},{quantity:3},{quantity:'1'},{smsConsent:false},{smsConsent:'true'},{name:' '},{phone:'2125551234'},{email:'bad'},{requestId:'abc'},{source:'other'}]) {
    assert.throws(() => validateReservation({...input(),...override}), ReservationError);
  }
});
test('two customers competing for one unit: one order, one conflict, one SMS', async () => {
  const ctx=setup(); const responses=await Promise.all([ctx.reserve(input()),ctx.reserve(input())]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
  assert.equal(responses.find(r=>r.status===409).body.code,'VARIANT_SOLD_OUT');
  assert.equal(ctx.orders.size,1);assert.equal(ctx.events.size,1);assert.equal(ctx.smsCount,1);
});
test('same request submitted concurrently or retried creates only one order', async () => {
  const ctx=setup({stock:2}), body=input();
  const responses=await Promise.all([ctx.reserve(body),ctx.reserve(body)]);
  assert.equal(responses.filter(r=>r.status===201).length,1);
  assert.equal(responses.find(r=>r.status===202).body.code,'RESERVATION_REVIEW_REQUIRED');
  const replay=await ctx.reserve(body);assert.equal(replay.body.reservationNumber,'NS-0001');
  assert.equal(ctx.orders.size,1);assert.equal(ctx.smsCount,1);
});
test('request key cannot be reused with different details', async () => {
  const ctx=setup(), body=input(); await ctx.reserve(body);
  const result=await ctx.reserve({...body,name:'Different'});
  assert.equal(result.body.code,'REQUEST_ID_REUSED');assert.equal(ctx.orders.size,1);
});
for (const failure of ['timeout','verify','store']) {
  test(`${failure}: no confirmation SMS or duplicate order after an ambiguous/partial failure`, async () => {
    const ctx=setup({stock:2,failure}),body=input();
    const response=await ctx.reserve(body);
    assert.equal(response.status,202);assert.equal(ctx.smsCount,0);
    await ctx.reserve(body);assert.equal(ctx.orders.size,1);
    assert.equal(ctx.requests.get(body.requestId).status,'review_required');
  });
}
test('SMS failure preserves confirmed order and records delivery failure', async () => {
  const ctx=setup({smsFailure:true}),body=input();const response=await ctx.reserve(body);
  assert.equal(response.body.success,true);assert.equal(response.body.smsStatus,'failed');
  assert.equal(ctx.requests.get(body.requestId).sms_status,'failed');
  await ctx.reserve(body);assert.equal(ctx.smsCount,1);
});
test('out of stock never creates an order or SMS', async () => {
  const ctx=setup({stock:0});const response=await ctx.reserve(input());
  assert.equal(response.status,409);assert.equal(ctx.orders.size,0);assert.equal(ctx.smsCount,0);
});
test('Shopify rejects unrelated/inactive/untracked/overselling variants', async () => {
  const valid={id:'gid://shopify/ProductVariant/456',title:'Medium',product:{id:'gid://shopify/Product/123',status:'ACTIVE'},inventoryItem:{tracked:true},inventoryPolicy:'DENY',inventoryQuantity:1};
  for (const variant of [null,{...valid,product:{id:'gid://shopify/Product/999',status:'ACTIVE'}},{...valid,product:{...valid.product,status:'DRAFT'}},{...valid,inventoryItem:{tracked:false}},{...valid,inventoryPolicy:'CONTINUE'}]) {
    const adapter=createPopupShopify(async()=>({productVariant:variant}));
    await assert.rejects(adapter.validateVariant(input()),ReservationError);
  }
});
test('Shopify mutation creates unpaid orders and uses policy-enforced inventory claims', async () => {
  const adapter=createPopupShopify(async(query,variables)=>{
    assert.equal(variables.options.inventoryBehaviour,'DECREMENT_OBEYING_POLICY');
    assert.equal(variables.order.financialStatus,'PENDING');
    assert.equal(variables.order.lineItems[0].variantId,'gid://shopify/ProductVariant/456');
    assert.equal(variables.options.sendReceipt,false);
    assert.equal(variables.order.transactions,undefined);
    assert.ok(variables.order.sourceIdentifier);
    assert.ok(variables.order.tags.includes('SOHO_POPUP'));
    assert.ok(variables.order.tags.includes('QR_RESERVATION'));
    const attributes = Object.fromEntries(variables.order.customAttributes.map(({key,value}) => [key,value]));
    assert.equal(attributes.reservation_code, 'NS-0247');
    assert.equal(attributes.external_payment_method, 'Pay In Store');
    assert.equal(attributes.source, 'soho-popup-qr');
    assert.match(variables.order.note, /NS-0247.*Pay In Store/);
    return {orderCreate:{order:null,userErrors:[{code:'INVENTORY_CLAIM_FAILED'}]}};
  });
  await assert.rejects(adapter.createOrder({...input(), reservationCode:'NS-0247'}),e=>e.code==='VARIANT_SOLD_OUT');
});
test('verification fails closed if committed inventory or order line is missing', async () => {
  const adapter=createPopupShopify(async()=>({order:{cancelledAt:null,displayFinancialStatus:'PENDING',lineItems:{nodes:[{quantity:1,unfulfilledQuantity:1,variant:{id:'gid://shopify/ProductVariant/456',inventoryPolicy:'DENY',inventoryItem:{tracked:true,inventoryLevels:{nodes:[{quantities:[{name:'committed',quantity:0}]}]}}}}]}}}));
  await assert.rejects(adapter.verifyOrder('gid://shopify/Order/1',input()),/commitment/);
});
test('Twilio request uses server credentials, correct recipient, and reservation number', async () => {
  const env={TWILIO_ACCOUNT_SID:'ACtest',TWILIO_AUTH_TOKEN:'secret',TWILIO_FROM_NUMBER:'+12125550000'};
  const result=await sendPopupSms({phone:'+12125551234',reservationNumber:'#1001'},env,async(url,options)=>{
    assert.equal(url,'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json');
    assert.equal(options.body.get('To'),'+12125551234');assert.match(options.body.get('Body'),/#1001/);
    assert.match(options.headers.Authorization,/^Basic /);
    return {ok:true,json:async()=>({sid:'SM123',status:'queued'})};
  });
  assert.equal(result.id,'SM123');
});


test('existing event_orders schema receives the reservation code, Shopify name and untouched workflow timestamps', async () => {
  const ctx=setup({smsDeferred:true}),body=input(); const response=await ctx.reserve(body);
  const event=ctx.events.get(ctx.orders.get(body.requestId).id);
  const columns=new Set(['id','reservation_code','shopify_order_id','shopify_order_name','product_id','variant_id','product_title','variant_title','quantity','customer_name','phone','email','status','sms_consent','confirmation_sms_sent_at','ready_at','expires_at','paid_at','collected_at','cancelled_at','created_at','updated_at']);
  for (const key of Object.keys(event)) assert.ok(columns.has(key), `Unexpected event_orders column: ${key}`);
  assert.equal(event.reservation_code,'NS-0001'); assert.equal(event.shopify_order_name,'#1');
  assert.equal(event.status,'received'); assert.equal(event.sms_consent,true);
  for (const key of ['ready_at','expires_at','paid_at','collected_at','cancelled_at','confirmation_sms_sent_at']) assert.equal(event[key],null);
  assert.equal(response.body.reservationCode,event.reservation_code);
  assert.equal(response.body.shopifyOrderName,'#1');
  assert.equal(response.body.smsStatus,'deferred'); assert.equal(ctx.smsCount,0);
  const replay=await ctx.reserve(body);
  assert.equal(replay.body.reservationCode,event.reservation_code); assert.equal(ctx.orders.size,1);
  assert.equal(ctx.requests.get(body.requestId).inventory_evidence.committed,1);
});

test('simultaneous different requests receive distinct codes', async () => {
  const ctx=setup({stock:2,smsDeferred:true});
  const responses=await Promise.all([ctx.reserve(input()),ctx.reserve(input())]);
  assert.equal(new Set(responses.map(r=>r.body.reservationCode)).size,2);
  assert.ok(responses.every(r=>/^NS-\d{4,}$/.test(r.body.reservationCode)));
  assert.equal(ctx.smsCount,0);
});
