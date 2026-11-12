import supabase from '../../lib/supabase.js';
import { shopifyGraphql } from '../../lib/shopify.js';
import { createNewsletterStore } from '../../lib/newsletter-store.js';
import { createNewsletterProcessHandler } from '../../lib/newsletter.js';

export default async function handler(req, res) {
  const signal = AbortSignal.timeout(45000);
  return createNewsletterProcessHandler({ store: createNewsletterStore(supabase),
    graphql: (query, variables) => shopifyGraphql(query, variables, { signal }) })(req, res);
}
