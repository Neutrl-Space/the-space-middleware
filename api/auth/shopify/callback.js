import { completeAuthorization } from '../../../lib/shopify.js';
import { createShopifyCallbackHandler } from '../../../lib/shopify-auth-callback.js';
import { sentryReporter } from '../../../lib/sentry.js';

export default createShopifyCallbackHandler({ completeAuthorization, reporter: sentryReporter });
