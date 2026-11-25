import { reportSecurityFailure } from './security-monitoring.js';

export function createShopifyCallbackHandler({ completeAuthorization, reporter, logger = console }) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      await completeAuthorization(req.query);
      return res.status(200).send('Shopify authorization completed. You can close this window.');
    } catch (error) {
      const status = error.statusCode || 500;
      // OAuth/provider exceptions can contain authorization codes or client secrets.
      try { logger.error(JSON.stringify({ event: 'shopify_authorization_failure', status })); } catch { /* Preserve response. */ }
      if (status === 401) await reportSecurityFailure({ route: 'shopify-oauth', reason: 'authentication_failed', status, reporter, logger });
      return res.status(status).send('Shopify authorization failed. Check the server logs for details.');
    }
  };
}
