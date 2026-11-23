import supabase from '../../lib/supabase.js';
import { shopifyGraphql } from '../../lib/shopify.js';
import { createNewsletterStore } from '../../lib/newsletter-store.js';
import { createNewsletterProcessHandler } from '../../lib/newsletter.js';
import { createNewsletterOfferHandler } from '../../lib/newsletter-offer.js';

export default async function handler(req, res) {
  const signal = AbortSignal.timeout(45000);
  const action = req.query?.__newsletterAction;
  if (action !== undefined && action !== 'offer') return res.status(404).json({ error: 'Not found.' });
  const createHandler = action === 'offer' ? createNewsletterOfferHandler : createNewsletterProcessHandler;
  return createHandler({ store: createNewsletterStore(supabase),
    graphql: (query, variables) => shopifyGraphql(query, variables, { signal }) })(req, res);
}
