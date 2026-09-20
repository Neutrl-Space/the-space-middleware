import supabase from '../lib/supabase.js';
import { shopifyGraphql } from '../lib/shopify.js';
import { createBecomingAccessHandler } from '../lib/becoming-access.js';

export default async (req, res) => {
  const signal = AbortSignal.timeout(45000);
  const graphql = (query, variables) => shopifyGraphql(query, variables, { signal });
  return createBecomingAccessHandler({ db: supabase, graphql })(req, res);
};
