import supabase from '../../lib/supabase.js';
import { createNewsletterStore } from '../../lib/newsletter-store.js';
import { createNewsletterWebhookHandler } from '../../lib/newsletter.js';
import { sentryReporter } from '../../lib/sentry.js';

export const config = { api: { bodyParser: false } };
export default createNewsletterWebhookHandler({ store: createNewsletterStore(supabase), reporter: sentryReporter });
