import { syncInterestMetafields } from './becoming-access-metafields.js';

const MAX_INTERESTS = 100;
const MAX_BODY_BYTES = 65536;

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function text(value, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
    throw invalid('Invalid or missing form fields.');
  }
  return value.trim();
}
function gid(value, type) {
  if (typeof value !== 'string') throw invalid('Invalid product or variant ID.');
  if (/^[1-9]\d*$/.test(value)) return `gid://shopify/${type}/${value}`;
  if (new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`).test(value)) return value;
  throw invalid('Invalid product or variant ID.');
}
export function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Invalid JSON body.');
  const name = text(body.name, 200, true);
  const email = text(body.email, 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Please enter a valid email address.');
  if (body.marketingConsent != null && typeof body.marketingConsent !== 'boolean') throw invalid('Invalid marketing consent.');
  if (!Array.isArray(body.interests) || !body.interests.length || body.interests.length > MAX_INTERESTS) {
    throw invalid(`Select between 1 and ${MAX_INTERESTS} product sizes or options.`);
  }
  const seen = new Set();
  const interests = body.interests.map((interest) => {
    if (!interest || typeof interest !== 'object') throw invalid('Invalid product selection.');
    const productId = gid(interest.productId, 'Product');
    const variantId = interest.variantId == null ? null : gid(interest.variantId, 'ProductVariant');
    const key = `${productId}:${variantId}`;
    if (seen.has(key)) throw invalid('Duplicate product selection.');
    seen.add(key);
    // Product names, handles and sizes are loaded from Shopify, never trusted here.
    return { productId, variantId };
  });
  const attribution = {};
  for (const key of ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'landingPage']) {
    attribution[key] = text(body.attribution?.[key], key === 'landingPage' ? 1000 : 200);
  }
  return { name, email, phone: text(body.phone, 50), marketingConsent: body.marketingConsent === true, interests, attribution };
}

export async function verifyInterests(interests, graphql, handle) {
  const { collectionByIdentifier: collection } = await graphql(
    `query AccessCollection($identifier: CollectionIdentifierInput!) {
      collectionByIdentifier(identifier: $identifier) { id }
    }`, { identifier: { handle } }
  );
  if (!collection) throw invalid('Becoming Access collection is not configured.', 503);
  const ids = [...new Set(interests.flatMap((item) => [item.productId, item.variantId].filter(Boolean)))];
  const { nodes } = await graphql(
    `query AccessSelections($ids: [ID!]!, $collectionId: ID!) {
      nodes(ids: $ids) {
        ... on Product { id title handle hasOnlyDefaultVariant inCollection(id: $collectionId) }
        ... on ProductVariant { id title product { id } selectedOptions { name value } }
      }
    }`, { ids, collectionId: collection.id }
  );
  const byId = new Map(nodes.filter(Boolean).map((node) => [node.id, node]));
  return interests.map(({ productId, variantId }) => {
    const product = byId.get(productId), variant = variantId ? byId.get(variantId) : null;
    if (!product?.inCollection) throw invalid('A selected product is not in the SoHo collection.');
    if (variantId && (!variant || variant.product.id !== productId)) throw invalid('A selected size does not belong to its product.');
    if (!variantId && !product.hasOnlyDefaultVariant) throw invalid(`Please select a size or option for ${product.title}.`);
    const size = variant?.selectedOptions.find((option) => /^(size|waist|waist size|shoe size)$/i.test(option.name.trim()));
    return { productId, productHandle: product.handle, productTitle: product.title, variantId,
      variantTitle: variant?.title || null, selectedSize: size?.value || null };
  });
}

function mutationResult(data, field) {
  const result = data[field];
  if (!result || result.userErrors?.length) throw new Error(`Shopify ${field} failed.`);
  return result;
}
export async function syncCustomer(contact, graphql, tags) {
  const findCustomer = async () => {
    const data = await graphql(`query AccessCustomer($query: String!) {
      customers(first: 10, query: $query) { nodes { id email } }
    }`, { query: `email:${JSON.stringify(contact.email)}` });
    return data.customers.nodes.find((customer) => customer.email?.toLowerCase() === contact.email);
  };
  let customer = await findCustomer();
  const [firstName, ...lastName] = contact.name.split(/\s+/);
  // Phone is retained in Supabase; don't overwrite Shopify phone/SMS consent.
  const profile = { firstName, lastName: lastName.join(' ') };
  if (!customer) {
    const created = await graphql(`mutation CreateAccessCustomer($input: CustomerInput!) {
      customerCreate(input: $input) { customer { id } userErrors { field message } }
    }`, { input: { email: contact.email, ...profile } });
    if (created.customerCreate?.userErrors?.length) {
      // A concurrent request may have created the same customer.
      customer = await findCustomer();
      if (!customer) throw new Error('Shopify customer creation failed.');
    } else {
      customer = mutationResult(created, 'customerCreate').customer;
    }
  } else {
    mutationResult(await graphql(`mutation UpdateAccessCustomer($input: CustomerInput!) {
      customerUpdate(input: $input) { customer { id } userErrors { field message } }
    }`, { input: { id: customer.id, ...profile } }), 'customerUpdate');
  }
  if (!customer?.id) throw new Error('Shopify customer was not returned.');
  mutationResult(await graphql(`mutation TagAccessCustomer($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
  }`, { id: customer.id, tags }), 'tagsAdd');
  if (contact.marketingConsent) {
    mutationResult(await graphql(`mutation AccessMarketingConsent($input: CustomerEmailMarketingConsentUpdateInput!) {
      customerEmailMarketingConsentUpdate(input: $input) { customer { id } userErrors { field message } }
    }`, { input: { customerId: customer.id, emailMarketingConsent: {
      marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: contact.consentUpdatedAt,
    } } }), 'customerEmailMarketingConsentUpdate');
  }
  return customer.id;
}

export async function synchronizeSubmission(db, graphql, record, tags) {
  try {
    const customerId = await syncCustomer(record.shopify_sync_payload, graphql, tags);
    const contact = await db.from('becoming_access_contacts').update({ shopify_customer_id: customerId }).eq('id', record.contact_id);
    if (contact.error) throw new Error('Shopify customer ID could not be saved.');
    const saved = await db.from('becoming_access_submissions')
      .select('id, created_at, campaign, becoming_access_interests(product_id, product_handle, product_title, variant_id, variant_title, selected_size)')
      .eq('id', record.id).single();
    if (saved.error || !saved.data) throw new Error('Unable to load saved interests.');
    await syncInterestMetafields(customerId, saved.data, graphql);
    const submission = await db.from('becoming_access_submissions').update({
      shopify_sync_status: 'synced', shopify_sync_error: null, shopify_synced_at: new Date().toISOString(),
    }).eq('id', record.id);
    if (submission.error) throw new Error('Shopify sync status could not be saved.');
    return true;
  } catch {
    try {
      const result = await db.from('becoming_access_submissions').update({
        shopify_sync_status: 'failed', shopify_sync_error: 'Shopify synchronization did not complete. Retry this submission.',
        shopify_synced_at: null,
      }).eq('id', record.id);
      // Pending rows are retryable too if this status update fails.
      if (result.error) console.error('Unable to record Becoming Access sync failure:', record.id);
    } catch {
      console.error('Unable to record Becoming Access sync failure:', record.id);
    }
    return false;
  }
}

async function readBody(req) {
  if (req.body !== undefined) {
    const raw = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw invalid('Request too large.', 413);
    try { return JSON.parse(raw); } catch { throw invalid('Invalid JSON body.'); }
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw invalid('Request too large.', 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid('Invalid JSON body.'); }
}
export function createBecomingAccessHandler({ db, graphql, env = process.env }) {
  return async (req, res) => {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    const allowed = (env.POPUP_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
    if (!allowed.length) return res.status(503).json({ error: 'Registration is not configured.' });
    if (!allowed.includes(req.headers.origin)) return res.status(403).json({ error: 'Origin not allowed.' });
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'Method not allowed.' }); }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({ error: 'Send application/json.' });
    try {
      const payload = validatePayload(await readBody(req));
      const handle = env.BECOMING_ACCESS_COLLECTION_HANDLE;
      if (!handle) throw invalid('Registration is not configured.', 503);
      const interests = await verifyInterests(payload.interests, graphql, handle);
      const syncPayload = { name: payload.name, email: payload.email, phone: payload.phone,
        marketingConsent: payload.marketingConsent, consentUpdatedAt: new Date().toISOString() };
      const saved = await db.rpc('save_becoming_access_request', { request_data: {
        ...payload, interests, campaign: env.BECOMING_ACCESS_CAMPAIGN || 'sep24_popup_2026', syncPayload,
      } });
      if (saved.error || !saved.data?.submission_id) throw new Error('Unable to save Becoming Access preferences.');
      const tags = (env.BECOMING_ACCESS_CUSTOMER_TAGS || 'becoming-access,soho-popup-2026,restock-interest').split(',').map((tag) => tag.trim()).filter(Boolean);
      // All reporting data is committed before optional Shopify synchronization.
      await synchronizeSubmission(db, graphql, { id: saved.data.submission_id, contact_id: saved.data.contact_id, shopify_sync_payload: syncPayload }, tags);
      return res.status(200).json({ success: true, message: 'Your Becoming Access preferences have been saved.' });
    } catch (error) {
      return res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'We couldn’t save your preferences. Please try again.' });
    }
  };
}
