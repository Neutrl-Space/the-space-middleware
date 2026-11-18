import supabase from '../lib/supabase.js';
import { shopifyGraphql } from '../lib/shopify.js';
import { createHealthHandler } from '../lib/monitoring.js';

export default createHealthHandler({ db: supabase, graphql: shopifyGraphql });
