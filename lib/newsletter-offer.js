import crypto from 'node:crypto';
import { newsletterConfig, processNewsletterJob, customer, eligible, findDiscount, validateDiscount } from './newsletter.js';

export const SESSION_TAG_PREFIX = 'ns-welcome-session:';
const TOKEN = /^[a-f0-9]{64}$/;
function invalid(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

async function readBody(req) {
  let raw;
  if (req.body !== undefined) raw = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
  else {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 1024) throw invalid('Request too large.', 413);
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(raw) > 1024) throw invalid('Request too large.', 413);
  let body;
  try { body = JSON.parse(raw); } catch { throw invalid('Invalid JSON.'); }
  if (!body || typeof body.token !== 'string' || !TOKEN.test(body.token)) throw invalid('Invalid signup session.');
  return body.token;
}

// A random bearer token travels through Shopify's native customer form as a tag.
// Only possession of that token AND its canonical Shopify tag can retrieve an offer.
// Email addresses, customer IDs and customer_posted=true are never authorization.
export function createNewsletterOfferHandler({ store, graphql, env = process.env, now = () => new Date() }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Vary', 'Origin');
    const origins = (env.POPUP_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (!origins.includes(req.headers.origin)) return res.status(403).json({ error: 'Origin not allowed.' });
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'Method not allowed.' }); }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({ error: 'Send application/json.' });
    try {
      const config = newsletterConfig(env);
      if (!config.enabled || env.NEWSLETTER_INSTANT_ENABLED !== 'true' || !env.SHOPIFY_CLIENT_SECRET) {
        throw invalid('Immediate offers are not enabled.', 503);
      }
      // The instant experience advertises 24 hours. Never silently issue a longer policy.
      if (config.rules.validityDays !== 1 || config.rules.usageLimit !== 1) throw invalid('Immediate offer rules are not configured.', 503);
      const token = await readBody(req);
      const digest = (value) => crypto.createHmac('sha256', env.SHOPIFY_CLIENT_SECRET).update(value).digest('hex');
      // On Vercel this header is platform-controlled. Do not trust arbitrary x-forwarded-for.
      const client = String(req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      if (!await store.allowStatus(digest(`client:${client}`), digest(`token:${token}`))) {
        res.setHeader('Retry-After', '60'); return res.status(429).json({ status: 'pending' });
      }
      await store.requireReady(config);
      const tag = `${SESSION_TAG_PREFIX}${token}`;
      const data = await graphql(`query NewsletterSignupSession($query: String!) {
        customers(first: 2, query: $query) { nodes { id tags } }
      }`, { query: `tag:'${tag}'` });
      const records = data.customers?.nodes || [];
      // Search indexes may lag; require an exact match and fail closed on ambiguity.
      if (records.length !== 1 || !records[0].tags.includes(tag)) return res.status(202).json({ status: 'pending' });
      let record = await customer(graphql, records[0].id);
      if (!record?.tags.includes(tag)) return res.status(202).json({ status: 'pending' });
      if (record.emailMarketingConsent?.marketingState !== 'SUBSCRIBED') {
        return res.status(202).json({ status: 'confirmation_required' });
      }
      await store.enqueue({ eventId: `session-${token}`, shop: config.shop, topic: 'customers_email_marketing_consent/update',
        customerId: record.id, kind: 'subscribe', consentAt: record.emailMarketingConsent.consentUpdatedAt,
        optInLevel: record.emailMarketingConsent.marketingOptInLevel }, config);
      const claimed = await store.claimCustomer(config, record.id);
      if (claimed) await processNewsletterJob({ store, graphql, job: claimed, now });
      const assignment = await store.assignment(config, record.id);
      if (!assignment || assignment.status === 'pending') return res.status(202).json({ status: 'pending' });
      if (assignment.status !== 'published' || assignment.revocation_requested || assignment.redeemed_order_id ||
          Date.parse(assignment.ends_at) <= now().getTime()) return res.status(200).json({ status: 'unavailable' });
      record = await customer(graphql, record.id);
      if (!record?.tags.includes(tag) || eligible(record, assignment.rules)) return res.status(200).json({ status: 'unavailable' });
      const node = await findDiscount(graphql, assignment.code);
      validateDiscount(node, assignment);
      if (!Number.isInteger(node.codeDiscount.asyncUsageCount)) throw new Error('Usage unavailable.');
      if (node.codeDiscount.asyncUsageCount > 0) return res.status(200).json({ status: 'unavailable' });
      return res.status(200).json({ status: 'ready', code: assignment.code, issuedAt: assignment.starts_at, expiresAt: assignment.ends_at });
    } catch (failure) {
      return res.status(failure.statusCode || 503).json({ error: failure.statusCode ? failure.message : 'Your offer is still being prepared. Please try again.' });
    }
  };
}
