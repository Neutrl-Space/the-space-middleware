import crypto from 'node:crypto';
import supabase from './supabase';

const SESSION_TABLE = 'shopify_app_sessions';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function requiredEnvironment(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function normalizeShop(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.myshopify\.com\/?$/, '')
    .replace(/\/$/, '');
}

function getConfig() {
  return {
    shop: normalizeShop(requiredEnvironment('SHOPIFY_SHOP')),
    clientId: requiredEnvironment('SHOPIFY_CLIENT_ID'),
    clientSecret: requiredEnvironment('SHOPIFY_CLIENT_SECRET'),
    redirectUri: requiredEnvironment('SHOPIFY_REDIRECT_URI'),
    scopes: requiredEnvironment('SHOPIFY_SCOPES'),
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-01',
  };
}

function sign(value) {
  return crypto
    .createHmac('sha256', requiredEnvironment('SHOPIFY_CLIENT_SECRET'))
    .update(value)
    .digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getState() {
  const issuedAt = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${issuedAt}.${nonce}`;

  return `${payload}.${sign(payload)}`;
}

function validateState(state) {
  const [issuedAt, nonce, signature] = String(state || '').split('.');
  const payload = `${issuedAt}.${nonce}`;
  const age = Date.now() - Number(issuedAt);

  if (!issuedAt || !nonce || !signature || !Number.isFinite(age) || age < 0 || age > 10 * 60 * 1000) {
    return false;
  }

  return safeEqual(signature, sign(payload));
}

function verifyCallbackHmac(query) {
  const receivedHmac = String(query.hmac || '');
  const message = Object.entries(query)
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
    .join('&');

  return safeEqual(receivedHmac, sign(message));
}

function toExpiry(seconds) {
  if (!seconds) return null;

  return new Date(Date.now() + Number(seconds) * 1000).toISOString();
}

async function saveSession(shop, tokenResponse) {
  const record = {
    shop,
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || null,
    scope: tokenResponse.scope || null,
    access_token_expires_at: toExpiry(tokenResponse.expires_in),
    refresh_token_expires_at: toExpiry(tokenResponse.refresh_token_expires_in),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from(SESSION_TABLE).upsert(record, { onConflict: 'shop' });

  if (error) {
    throw new Error(`Unable to store Shopify session: ${error.message}`);
  }
}

async function exchangeToken(body) {
  const { shop, clientId, clientSecret } = getConfig();
  const response = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Shopify token exchange failed');
  }

  return data;
}

async function getStoredSession() {
  const { shop } = getConfig();
  const { data, error } = await supabase
    .from(SESSION_TABLE)
    .select('*')
    .eq('shop', shop)
    .maybeSingle();

  if (error) throw new Error(`Unable to load Shopify session: ${error.message}`);
  if (!data) {
    const setupError = new Error('Shopify has not been authorized yet. Visit /api/auth/shopify first.');
    setupError.statusCode = 503;
    throw setupError;
  }

  return data;
}

async function getAccessToken() {
  const session = await getStoredSession();
  const expiry = session.access_token_expires_at ? new Date(session.access_token_expires_at).getTime() : null;

  if (!expiry || expiry > Date.now() + REFRESH_BUFFER_MS) {
    return session.access_token;
  }

  if (!session.refresh_token) {
    const setupError = new Error('Shopify authorization expired. Visit /api/auth/shopify to reconnect the app.');
    setupError.statusCode = 503;
    throw setupError;
  }

  const refreshed = await exchangeToken({
    grant_type: 'refresh_token',
    refresh_token: session.refresh_token,
  });
  const { shop } = getConfig();
  await saveSession(shop, refreshed);

  return refreshed.access_token;
}

export function getAuthorizationUrl() {
  const { shop, clientId, redirectUri, scopes } = getConfig();
  const search = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    redirect_uri: redirectUri,
    state: getState(),
  });

  return `https://${shop}.myshopify.com/admin/oauth/authorize?${search.toString()}`;
}

export async function completeAuthorization(query) {
  const { shop } = getConfig();

  if (normalizeShop(query.shop) !== shop || !verifyCallbackHmac(query) || !validateState(query.state) || !query.code) {
    const error = new Error('Invalid Shopify authorization callback.');
    error.statusCode = 401;
    throw error;
  }

  const tokenResponse = await exchangeToken({ code: String(query.code), expiring: '1' });
  await saveSession(shop, tokenResponse);
}

export async function shopifyGraphql(query, variables = {}) {
  const { shop, apiVersion } = getConfig();
  const response = await fetch(`https://${shop}.myshopify.com/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await getAccessToken(),
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();

  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.map((error) => error.message).join(', ') || 'Shopify GraphQL request failed');
  }

  return payload.data;
}

export async function upsertInviteCustomer(invite) {
  const customerSearch = await shopifyGraphql(
    `query FindCustomer($query: String!) {
      customers(first: 1, query: $query) { nodes { id } }
    }`,
    { query: `email:${invite.email}` }
  );
  const existingCustomer = customerSearch.customers.nodes[0];

  if (existingCustomer) {
    const taggedCustomer = await shopifyGraphql(
      `mutation TagCustomer($id: ID!) {
        tagsAdd(id: $id, tags: ["space_invite_request"]) {
          node { ... on Customer { id } }
          userErrors { field message }
        }
      }`,
      { id: existingCustomer.id }
    );
    const errors = taggedCustomer.tagsAdd.userErrors;

    if (errors.length) throw new Error(errors.map((error) => error.message).join(', '));
    if (invite.emailMarketingOptIn) {
      await subscribeCustomerToEmailMarketing(existingCustomer.id);
    }
    return existingCustomer.id;
  }

  const [firstName, ...lastNameParts] = invite.name.split(/\s+/);
  const createdCustomer = await shopifyGraphql(
    `mutation CreateCustomer($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        email: invite.email,
        firstName: firstName || undefined,
        lastName: lastNameParts.join(' ') || undefined,
        tags: ['space_invite_request'],
        emailMarketingConsent: invite.emailMarketingOptIn
          ? {
              marketingState: 'SUBSCRIBED',
              marketingOptInLevel: 'SINGLE_OPT_IN',
              consentUpdatedAt: new Date().toISOString(),
            }
          : undefined,
      },
    }
  );
  const errors = createdCustomer.customerCreate.userErrors;

  if (errors.length) throw new Error(errors.map((error) => error.message).join(', '));
  return createdCustomer.customerCreate.customer.id;
}

async function subscribeCustomerToEmailMarketing(customerId) {
  const result = await shopifyGraphql(
    `mutation SubscribeCustomerToEmailMarketing($input: CustomerEmailMarketingConsentUpdateInput!) {
      customerEmailMarketingConsentUpdate(input: $input) {
        customer { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        customerId,
        emailMarketingConsent: {
          marketingState: 'SUBSCRIBED',
          marketingOptInLevel: 'SINGLE_OPT_IN',
          consentUpdatedAt: new Date().toISOString(),
        },
      },
    }
  );
  const errors = result.customerEmailMarketingConsentUpdate.userErrors;

  if (errors.length) throw new Error(errors.map((error) => error.message).join(', '));
}

export async function createInviteRequest(invite, customerId) {
  const metaobject = await shopifyGraphql(
    `mutation CreateInviteRequest($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message code }
      }
    }`,
    {
      metaobject: {
        type: process.env.SHOPIFY_METAOBJECT_TYPE || 'invite_request',
        fields: [
          { key: 'email', value: invite.email },
          { key: 'full_name', value: invite.name },
          { key: 'instagram', value: invite.handle || 'Not provided' },
          { key: 'note', value: invite.note || 'Not provided' },
          { key: 'submitted_at', value: new Date().toISOString() },
          { key: 'customer', value: customerId },
          { key: 'status', value: 'pending' },
        ],
      },
    }
  );
  const errors = metaobject.metaobjectCreate.userErrors;

  if (errors.length) throw new Error(errors.map((error) => error.message).join(', '));
  return metaobject.metaobjectCreate.metaobject;
}
