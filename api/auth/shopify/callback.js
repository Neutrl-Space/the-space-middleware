import { completeAuthorization } from '../../../lib/shopify';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await completeAuthorization(req.query);
    return res.status(200).send('Shopify authorization completed. You can close this window.');
  } catch (error) {
    console.error('Shopify authorization failed:', error);
    return res.status(error.statusCode || 500).send('Shopify authorization failed. Check the server logs for details.');
  }
}
