const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function getInstallationsEndpoint(shop) {
  if (!SUPABASE_URL) {
    throw new Error('SUPABASE_URL is not set');
  }

  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_SERVICE_KEY is not set');
  }

  const params = new URLSearchParams();
  if (shop) {
    params.set('shop', `eq.${shop}`);
  }
  params.set('select', 'shop,access_token,scope,installed_at,updated_at');
  params.set('limit', '1');

  return `${SUPABASE_URL}/rest/v1/shopify_installations?${params.toString()}`;
}

async function getShopifyInstallation(shop = null) {
  const response = await fetch(getInstallationsEndpoint(shop), {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Shopify installation: ${await response.text()}`);
  }

  const data = await response.json();
  return data?.[0] || null;
}

async function saveShopifyInstallation({ shop, accessToken, scope }) {
  if (!SUPABASE_URL) {
    throw new Error('SUPABASE_URL is not set');
  }

  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_SERVICE_KEY is not set');
  }

  if (!shop) throw new Error('shop is required');
  if (!accessToken) throw new Error('accessToken is required');

  const response = await fetch(`${SUPABASE_URL}/rest/v1/shopify_installations?on_conflict=shop`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify({
      shop,
      access_token: accessToken,
      scope: scope || null,
      installed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to save Shopify installation: ${await response.text()}`);
  }

  const data = await response.json();
  return data?.[0] || null;
}

module.exports = {
  getShopifyInstallation,
  saveShopifyInstallation
};
