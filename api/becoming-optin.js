import { shopifyGraphql } from '../lib/shopify.js';
import { createOptinHandler } from '../lib/becoming-optin.js';
export default async (req, res) => {
  const signal = AbortSignal.timeout(45000);
  return createOptinHandler({ graphql: (query, variables) => shopifyGraphql(query, variables, { signal }) })(req, res);
};
