import 'dotenv/config';
import supabase from '../lib/supabase.js';
import { shopifyGraphql } from '../lib/shopify.js';
import { newsletterConfig } from '../lib/newsletter.js';

const config = newsletterConfig();
if (config.enabled) throw new Error('Disable NEWSLETTER_ENABLED before taking the launch baseline.');
if (!process.argv.includes('--confirm')) throw new Error('This records existing subscribers as ineligible for this campaign. Re-run with --confirm after reviewing the setup guide.');
const { data: existing, error: lookupError } = await supabase.from('newsletter_campaigns')
  .select('baseline_completed_at').eq('shop', config.shop).eq('campaign', config.campaign).maybeSingle();
if (lookupError) throw new Error('Unable to inspect the newsletter baseline.');
if (existing?.baseline_completed_at) throw new Error('Baseline already completed. Never resnapshot a launched campaign.');
const started = await supabase.from('newsletter_campaigns').upsert({ shop: config.shop, campaign: config.campaign }, { onConflict: 'shop,campaign', ignoreDuplicates: true });
if (started.error) throw new Error('Unable to initialize the newsletter campaign.');
let after = null, total = 0;
do {
  const data = await shopifyGraphql(`query NewsletterBaseline($after: String) {
    customers(first: 100, after: $after) {
      nodes { id emailMarketingConsent { marketingState } }
      pageInfo { hasNextPage endCursor }
    }
  }`, { after });
  const rows = data.customers.nodes.filter((customer) => customer.emailMarketingConsent?.marketingState === 'SUBSCRIBED')
    .map((customer) => ({ shop: config.shop, campaign: config.campaign, customer_id: customer.id,
      rules: config.rules, status: 'ineligible', reason: 'existing_subscriber' }));
  if (rows.length) {
    const saved = await supabase.from('newsletter_assignments').upsert(rows, { onConflict: 'shop,campaign,customer_id', ignoreDuplicates: true });
    if (saved.error) throw new Error('Unable to save the subscriber baseline. It remains incomplete; retry with the campaign disabled.');
    total += rows.length;
  }
  after = data.customers.pageInfo.hasNextPage ? data.customers.pageInfo.endCursor : null;
} while (after);
const completed = await supabase.from('newsletter_campaigns').update({ baseline_completed_at: new Date().toISOString() })
  .eq('shop', config.shop).eq('campaign', config.campaign);
if (completed.error) throw new Error('Unable to complete the baseline. Leave the campaign disabled.');
console.log(`Baseline complete: ${total} existing subscribers excluded. No discounts created or emails sent.`);
