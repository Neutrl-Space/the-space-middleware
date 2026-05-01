import { createHmac, timingSafeEqual } from 'crypto';
import { saveShopifyInstallation } from '../../lib/shopify-installations';

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_REDIRECT_URL = process.env.SHOPIFY_REDIRECT_URL;

function normalizeShop(shop) {
  if (!shop) return '';
  if (shop.endsWith('.myshopify.com')) return shop;
  return `${shop}.myshopify.com`;
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((acc, pair) => {
    const [key, ...rest] = pair.trim().split('=');
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function isValidHmac(query) {
  const params = new URLSearchParams(query);
  const providedHmac = params.get('hmac');
  if (!providedHmac) return false;

  params.delete('hmac');
  params.delete('signature');

  const message = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
    .join('&');

  const generated = createHmac('sha256', SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest('hex');

  const generatedBuffer = Buffer.from(generated, 'hex');
  const providedBuffer = Buffer.from(providedHmac, 'hex');

  if (generatedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(generatedBuffer, providedBuffer);
}

export default async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!SHOPIFY_CLIENT_ID) {
      return res.status(500).send('SHOPIFY_CLIENT_ID is not set.');
    }

    if (!SHOPIFY_CLIENT_SECRET) {
      return res.status(500).send('SHOPIFY_CLIENT_SECRET is not set.');
    }

    if (!SHOPIFY_REDIRECT_URL) {
      return res.status(500).send('SHOPIFY_REDIRECT_URL is not set.');
    }

    const { code, shop, state } = req.query;
    const cookies = parseCookies(req.headers.cookie || '');

    if (!code || !shop || !state) {
      return res.status(400).send('Invalid OAuth callback.');
    }

    if (cookies.shopify_oauth_state !== state) {
      return res.status(400).send('Invalid OAuth state.');
    }

    if (!isValidHmac(req.query)) {
      return res.status(400).send('Invalid OAuth signature.');
    }

    const normalizedShop = normalizeShop(shop);

    const tokenResponse = await fetch(
      `https://${normalizedShop}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: new URLSearchParams({
          client_id: SHOPIFY_CLIENT_ID,
          client_secret: SHOPIFY_CLIENT_SECRET,
          code: Array.isArray(code) ? code[0] : code
        })
      }
    );

    if (!tokenResponse.ok) {
      return res.status(500).send(`Shopify token error: ${await tokenResponse.text()}`);
    }

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      return res.status(500).send('Shopify token exchange failed.');
    }

    await saveShopifyInstallation({
      shop: normalizedShop,
      accessToken: tokenData.access_token,
      scope: tokenData.scope || ''
    });

    res.setHeader(
      'Set-Cookie',
      'shopify_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
    );

    return res.redirect('/?installed=1');
  } catch (error) {
    console.error('Shopify callback error:', error);
    return res.status(500).send('Something went wrong.');
  }
};
