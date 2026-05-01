const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const SHOPIFY_METAOBJECT_TYPE =
  process.env.SHOPIFY_METAOBJECT_TYPE || 'approved_project';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function getShopifyEndpoint() {
  if (!SHOPIFY_SHOP) {
    throw new Error('SHOPIFY_SHOP is not set');
  }

  return `https://${SHOPIFY_SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

function getShopifyTokenEndpoint() {
  if (!SHOPIFY_SHOP) {
    throw new Error('SHOPIFY_SHOP is not set');
  }

  return `https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`;
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  if (!SHOPIFY_CLIENT_ID) {
    throw new Error('SHOPIFY_CLIENT_ID is not set');
  }

  if (!SHOPIFY_CLIENT_SECRET) {
    throw new Error('SHOPIFY_CLIENT_SECRET is not set');
  }

  const response = await fetch(getShopifyTokenEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET
    })
  });

  if (!response.ok) {
    throw new Error(`Shopify token error: ${await response.text()}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error('Shopify token error: missing access_token in response');
  }

  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = Date.now() + (data.expires_in || 0) * 1000;

  return cachedAccessToken;
}

async function shopifyGraphql(query, variables) {
  const response = await fetch(getShopifyEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await getAccessToken()
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`Shopify error: ${await response.text()}`);
  }

  const data = await response.json();
  if (data.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors)}`);
  }

  return data;
}

async function upsertApprovedProjectMetaobject(submission) {
  const handle = `supabase-${submission.id}`;

  const mutation = `
    mutation UpsertApprovedProject(
      $handle: MetaobjectHandleInput!
      $metaobject: MetaobjectUpsertInput!
    ) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject {
          id
          handle
          type
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    handle: {
      type: SHOPIFY_METAOBJECT_TYPE,
      handle
    },
    metaobject: {
      fields: [
        { key: 'project_name', value: submission.project_name || '' },
        { key: 'submitter', value: submission.name || '' },
        { key: 'email', value: submission.email || '' },
        { key: 'description', value: submission.description || '' },
        { key: 'category', value: submission.category || '' },
        { key: 'image_url', value: submission.image_url || '' },
        { key: 'link', value: submission.link || '' },
        { key: 'approved_at', value: new Date().toISOString() },
        { key: 'supabase_id', value: String(submission.id) }
      ]
    }
  };

  const data = await shopifyGraphql(mutation, variables);
  const payload = data.data?.metaobjectUpsert;

  if (payload?.userErrors?.length > 0) {
    throw new Error(
      `Shopify metaobject error: ${payload.userErrors
        .map((error) => error.message)
        .join(', ')}`
    );
  }

  return payload?.metaobject || null;
}

async function deleteApprovedProjectMetaobject(supabaseId) {
  const query = `
    query FindApprovedProject($query: String!) {
      metaobjects(type: "${SHOPIFY_METAOBJECT_TYPE}", first: 1, query: $query) {
        nodes {
          id
        }
      }
    }
  `;

  const search = `fields.supabase_id:${supabaseId}`;
  const data = await shopifyGraphql(query, { query: search });
  const metaobjectId = data.data?.metaobjects?.nodes?.[0]?.id;

  if (!metaobjectId) {
    return null;
  }

  const deleteMutation = `
    mutation DeleteApprovedProject($where: MetaobjectBulkDeleteWhereCondition!) {
      metaobjectBulkDelete(where: $where) {
        job {
          id
          done
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const deleteData = await shopifyGraphql(deleteMutation, {
    where: { ids: [metaobjectId] }
  });

  const payload = deleteData.data?.metaobjectBulkDelete;
  if (payload?.userErrors?.length > 0) {
    throw new Error(
      `Shopify delete error: ${payload.userErrors
        .map((error) => error.message)
        .join(', ')}`
    );
  }

  return metaobjectId;
}

module.exports = {
  upsertApprovedProjectMetaobject,
  deleteApprovedProjectMetaobject
};
