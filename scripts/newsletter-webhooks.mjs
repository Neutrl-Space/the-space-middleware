import 'dotenv/config';
import { shopifyGraphql } from '../lib/shopify.js';
import { configureNewsletterWebhooks } from '../lib/newsletter-webhooks.js';

try {
  const result = await configureNewsletterWebhooks({ graphql: shopifyGraphql, apply: process.argv.includes('--apply') });
  console.log(`Newsletter webhook URL: ${result.url}`);
  for (const item of result.subscriptions) console.log(`${item.topic}: ${item.status}`);
  if (!process.argv.includes('--apply')) console.log('Read-only check complete. Use --apply after deploying and enabling webhook collection to register missing subscriptions.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
