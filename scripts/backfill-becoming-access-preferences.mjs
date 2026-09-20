import 'dotenv/config';
import supabase from '../lib/supabase.js';
import { shopifyGraphql } from '../lib/shopify.js';
import { syncInterestMetafields } from '../lib/becoming-access-metafields.js';

// Dry run by default. Writes only preference metafields, never marketing consent.
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some((arg) => arg !== '--apply')) throw new Error('Only --apply is supported.');
let processed = 0, failed = 0;
for (let offset = 0; ; offset += 100) {
  const { data: contacts, error } = await supabase.from('becoming_access_contacts')
    .select('id, shopify_customer_id').not('shopify_customer_id', 'is', null)
    .order('id').range(offset, offset + 99);
  if (error) throw new Error('Unable to load Becoming Access contacts.');
  for (const contact of contacts) {
    try {
      const { data: submission, error: readError } = await supabase.from('becoming_access_submissions')
        .select('id, created_at, campaign, becoming_access_interests(product_id, product_handle, product_title, variant_id, variant_title, selected_size)')
        .eq('contact_id', contact.id).order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(1).maybeSingle();
      if (readError) throw new Error('Unable to load saved preferences.');
      if (!submission) continue;
      if (apply) await syncInterestMetafields(contact.shopify_customer_id, submission, shopifyGraphql);
      processed++;
      console.log(`${contact.id}: ${apply ? 'preferences synchronized' : 'would synchronize preferences'}`);
    } catch {
      failed++;
      console.error(`${contact.id}: preference backfill failed; rerun to retry.`);
    }
  }
  if (contacts.length < 100) break;
}
console.log(`${processed} ${apply ? 'processed' : 'eligible'}; ${failed} failed.`);
if (failed) process.exitCode = 1;
