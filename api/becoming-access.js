import supabase from '../lib/supabase.js';
import { shopifyGraphql } from '../lib/shopify.js';
import { createBecomingAccessHandler } from '../lib/becoming-access.js';
import { withRequestMonitoring } from '../lib/monitoring.js';

export default withRequestMonitoring(async (req, res) => {
  const signal = AbortSignal.timeout(45000);
  const graphql = (query, variables) => shopifyGraphql(query, variables, { signal });
  return createBecomingAccessHandler({ db: supabase, graphql })(req, res);
}, 'becoming-access');
