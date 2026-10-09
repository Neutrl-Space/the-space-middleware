import { invalidConsent as invalid, normalizeSmsPhone, consentResult as result, updateSmsConsent } from './marketing-consent.js';
export function validateOptin(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Invalid form submission.');
  if (body.website) throw invalid('Unable to accept this submission.');
  if (body.emailConsent !== true || typeof body.smsConsent !== 'boolean') throw invalid('Please confirm your marketing preferences.');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Please enter a valid email address.');
  return { email, smsConsent: body.smsConsent, phone: body.smsConsent ? normalizeSmsPhone(body.phone) : '' };
}
export async function subscribeOptin(payload, graphql) {
  const find = async () => {
    const data = await graphql(`query BecomingOptinCustomer($query: String!) {
      customers(first: 10, query: $query) { nodes { id email phone } }
    }`, { query: `email:${JSON.stringify(payload.email)}` });
    return data.customers.nodes.find((c) => c.email?.toLowerCase() === payload.email);
  };
  let customer = await find();
  if (!customer) {
    const data = await graphql(`mutation BecomingOptinCreate($input: CustomerInput!) {
      customerCreate(input: $input) { customer { id email phone } userErrors { field message } }
    }`, { input: { email: payload.email } });
    if (data.customerCreate?.userErrors?.length) {
      customer = await find();
      if (!customer) throw new Error('Customer could not be created.');
    } else customer = result(data, 'customerCreate').customer;
  }
  if (!customer?.id) throw new Error('Customer not returned.');
  const consentUpdatedAt = new Date().toISOString();
  // SMS errors are surfaced before changing email preferences where possible.
  await updateSmsConsent(customer, { ...payload, consentUpdatedAt }, graphql);
  result(await graphql(`mutation BecomingOptinEmail($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) { customer { id } userErrors { field message } }
  }`, { input: { customerId: customer.id, emailMarketingConsent: {
    marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt,
  } } }), 'customerEmailMarketingConsentUpdate');
  result(await graphql(`mutation BecomingOptinTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
  }`, { id: customer.id, tags: ['becoming:optin'] }), 'tagsAdd');
  const verified = await graphql(`query VerifyBecomingOptin($id: ID!) {
    customer(id: $id) { tags emailMarketingConsent { marketingState } smsMarketingConsent { marketingState } }
  }`, { id: customer.id });
  if (verified.customer?.emailMarketingConsent?.marketingState !== 'SUBSCRIBED' || !verified.customer.tags.includes('becoming:optin') ||
    (payload.smsConsent && verified.customer.smsMarketingConsent?.marketingState !== 'SUBSCRIBED')) throw new Error('Consent verification failed.');
  return customer.id;
}
export function createOptinHandler({ graphql, env = process.env }) {
  return async (req, res) => {
    res.setHeader('Vary', 'Origin'); res.setHeader('Cache-Control', 'no-store');
    const allowed = (env.POPUP_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.length) return res.status(503).json({ error: 'Subscriptions are not configured.' });
    if (!allowed.includes(req.headers.origin)) return res.status(403).json({ error: 'Origin not allowed.' });
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'Method not allowed.' }); }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({ error: 'Send application/json.' });
    try {
      let raw;
      if (req.body !== undefined) raw = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
      else {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 4096) throw invalid('Request too large.', 413); chunks.push(Buffer.from(chunk)); }
        raw = Buffer.concat(chunks).toString('utf8');
      }
      if (Buffer.byteLength(raw) > 4096) throw invalid('Request too large.', 413);
      let body; try { body = JSON.parse(raw); } catch { throw invalid('Invalid JSON body.'); }
      await subscribeOptin(validateOptin(body), graphql);
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'We couldn’t confirm all your preferences. Please try again. Some preferences may already be saved.' });
    }
  };
}
