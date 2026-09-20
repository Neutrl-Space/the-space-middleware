import 'dotenv/config';
import supabase from '../lib/supabase.js';
import { shopifyGraphql } from '../lib/shopify.js';
import { synchronizeSubmission } from '../lib/becoming-access.js';

const limit = Number(process.argv[2] || 25);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Batch size must be 1–100.');
const { data, error } = await supabase.from('becoming_access_submissions')
  .select('id, contact_id, shopify_sync_payload')
  .in('shopify_sync_status', ['pending', 'failed'])
  .not('shopify_sync_payload', 'is', null)
  .lt('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
  .order('created_at', { ascending: true }).limit(limit);
if (error) throw new Error('Unable to load pending Becoming Access submissions.');
const tags = (process.env.BECOMING_ACCESS_CUSTOMER_TAGS || 'becoming-access,soho-popup-2026,restock-interest')
  .split(',').map((tag) => tag.trim()).filter(Boolean);
let failed = 0;
for (const submission of data) {
  const synced = await synchronizeSubmission(supabase, shopifyGraphql, submission, tags);
  if (!synced) failed++;
  console.log(`${submission.id}: ${synced ? 'synced' : 'failed'}`);
}
console.log(`Processed ${data.length} submissions; ${failed} still pending retry.`);
if (failed) process.exitCode = 1;
