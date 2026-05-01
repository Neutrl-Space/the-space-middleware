import { randomBytes } from 'crypto';

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_SCOPES = process.env.SHOPIFY_SCOPES || 'read_metaobjects,write_metaobjects';
const SHOPIFY_REDIRECT_URL = process.env.SHOPIFY_REDIRECT_URL;

function normalizeShop(shop) {
  if (!shop) return '';
  if (shop.endsWith('.myshopify.com')) return shop;
  return `${shop}.myshopify.com`;
}

export default async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!SHOPIFY_CLIENT_ID) {
      return res.status(500).send('SHOPIFY_CLIENT_ID is not set.');
    }

    if (!SHOPIFY_REDIRECT_URL) {
      return res.status(500).send('SHOPIFY_REDIRECT_URL is not set.');
    }

    const shop = normalizeShop(req.query.shop);
    if (!shop) {
      return res.status(400).send('Missing shop.');
    }

    const state = randomBytes(16).toString('hex');
    const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', SHOPIFY_CLIENT_ID);
    authorizeUrl.searchParams.set('scope', SHOPIFY_SCOPES);
    authorizeUrl.searchParams.set('redirect_uri', SHOPIFY_REDIRECT_URL);
    authorizeUrl.searchParams.set('state', state);

    res.setHeader(
      'Set-Cookie',
      `shopify_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
    );

    return res.redirect(authorizeUrl.toString());
  } catch (error) {
    console.error('Shopify auth error:', error);
    return res.status(500).send('Something went wrong.');
  }
};
