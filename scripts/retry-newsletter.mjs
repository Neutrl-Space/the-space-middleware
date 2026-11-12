import 'dotenv/config';
import supabase from '../lib/supabase.js';
import { shopifyGraphql } from '../lib/shopify.js';
import { createNewsletterStore } from '../lib/newsletter-store.js';
import { newsletterConfig, runNewsletterWorker } from '../lib/newsletter.js';

const limit = Number(process.argv[2] || 25);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Batch size must be 1–100.');
const signal = AbortSignal.timeout(45000);
const result = await runNewsletterWorker({ store: createNewsletterStore(supabase), config: newsletterConfig(), limit,
  graphql: (query, variables) => shopifyGraphql(query, variables, { signal }) });
console.log(`Processed ${result.processed} newsletter jobs; ${result.retry} retained for retry.`);
if (result.retry) process.exitCode = 1;
