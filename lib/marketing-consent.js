export const invalidConsent = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export function normalizeSmsPhone(value) {
  const phone = typeof value === 'string' ? value.trim().replace(/[\s().-]/g, '') : '';
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw invalidConsent('For SMS, enter your phone number with country code, for example +12125551234.');
  return phone;
}
export function consentResult(data, field) {
  const result = data[field];
  if (!result || result.userErrors?.length) throw new Error(`Shopify ${field} failed.`);
  return result;
}
export async function updateSmsConsent(customer, contact, graphql) {
  if (contact.smsConsent !== true) return;
  const phone = normalizeSmsPhone(contact.phone);
  if (customer.phone && normalizeSmsPhone(customer.phone) !== phone) {
    throw invalidConsent('This email has a different phone number on file. Use that number or leave SMS unchecked.', 409);
  }
  if (!customer.phone) consentResult(await graphql(`mutation BecomingConsentPhone($input: CustomerInput!) {
    customerUpdate(input: $input) { customer { id } userErrors { field message } }
  }`, { input: { id: customer.id, phone } }), 'customerUpdate');
  consentResult(await graphql(`mutation BecomingSmsConsent($input: CustomerSmsMarketingConsentUpdateInput!) {
    customerSmsMarketingConsentUpdate(input: $input) { customer { id } userErrors { field message } }
  }`, { input: { customerId: customer.id, smsMarketingConsent: {
    marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: contact.consentUpdatedAt,
  } } }), 'customerSmsMarketingConsentUpdate');
  const data = await graphql(`query VerifyBecomingSmsConsent($id: ID!) {
    customer(id: $id) { phone smsMarketingConsent { marketingState } }
  }`, { id: customer.id });
  if (data.customer?.smsMarketingConsent?.marketingState !== 'SUBSCRIBED' || data.customer.phone !== phone) throw new Error('SMS consent was not confirmed.');
}
