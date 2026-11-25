// Read-only catalog audit. No mutations, customers, orders or inventory quantities.
const PRODUCTS = `query MonitoringPreorderProducts($after: String) {
  products(first: 50, after: $after, sortKey: ID) {
    nodes { id handle status preorder: metafield(namespace: "custom", key: "preorder") { type value }
      shipDate: metafield(namespace: "custom", key: "preorder_ship_date") { type value } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const VARIANTS = `query MonitoringPreorderVariants($id: ID!, $after: String) {
  product(id: $id) { variants(first: 50, after: $after) {
    nodes { id inventoryPolicy inventoryItem { tracked } }
    pageInfo { hasNextPage endCursor }
  } }
}`;

function validDate(field) {
  if (field?.type !== 'date' || !/^\d{4}-\d{2}-\d{2}$/.test(field.value || '')) return false;
  const date = new Date(`${field.value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === field.value;
}

async function* pages(read) {
  let after = null;
  const seen = new Set();
  do {
    const connection = await read(after);
    if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error('Incomplete catalog response');
    }
    yield connection.nodes;
    if (!connection.pageInfo.hasNextPage) return;
    after = connection.pageInfo.endCursor;
    if (typeof after !== 'string' || !after || seen.has(after)) throw new Error('Incomplete pagination');
    seen.add(after);
  } while (true);
}

export async function checkPreorders({ graphql, signal, maxQueries = 200 }) {
  let queries = 0;
  const result = { status: 'ok', productsScanned: 0, preorderProducts: 0, variantsChecked: 0,
    findingCount: 0, findings: [], findingsTruncated: false };
  async function query(document, variables) {
    signal?.throwIfAborted();
    if (++queries > maxQueries) throw new Error('Catalog scan limit exceeded');
    return graphql(document, variables, { signal });
  }
  function finding(product, code, variant) {
    result.findingCount++;
    if (result.findings.length < 100) result.findings.push({ productId: product.id, handle: product.handle,
      ...(variant ? { variantId: variant.id } : {}), code });
    else result.findingsTruncated = true;
  }
  for await (const products of pages(async after => (await query(PRODUCTS, { after }))?.products)) {
    for (const product of products) {
      if (!/^gid:\/\/shopify\/Product\/\d+$/.test(product?.id || '') ||
          typeof product.handle !== 'string' || typeof product.status !== 'string') throw new Error('Incomplete product');
      result.productsScanned++;
      if (product.status === 'ARCHIVED' || !product.preorder) continue;
      if (product.preorder.type !== 'boolean' || !['true', 'false'].includes(product.preorder.value)) {
        finding(product, 'invalid_preorder_flag');
        continue;
      }
      if (product.preorder.value !== 'true') continue;
      result.preorderProducts++;
      if (!validDate(product.shipDate)) finding(product, 'missing_or_invalid_ship_date');
      let count = 0;
      for await (const variants of pages(async after => (await query(VARIANTS, { id: product.id, after }))?.product?.variants)) {
        for (const variant of variants) {
          if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant?.id || '') ||
              !['DENY', 'CONTINUE'].includes(variant.inventoryPolicy) ||
              typeof variant.inventoryItem?.tracked !== 'boolean') throw new Error('Incomplete variant');
          count++; result.variantsChecked++;
          if (!variant.inventoryItem.tracked) finding(product, 'inventory_not_tracked', variant);
          if (variant.inventoryPolicy === 'CONTINUE') finding(product, 'continue_selling_enabled', variant);
        }
      }
      if (!count) throw new Error('Missing variants');
    }
  }
  result.status = result.findingCount ? 'invalid' : 'ok';
  return result;
}

export async function servePreorderCheck({ graphql, reporter, res, timeoutMs = 20000, now = Date.now }) {
  const started = now();
  const signal = AbortSignal.timeout(timeoutMs);
  let timer;
  let result;
  try {
    result = await Promise.race([
      checkPreorders({ graphql, signal }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out')), timeoutMs); }),
    ]);
  } catch {
    // Never expose upstream exception messages, tokens or partial success.
    result = { status: 'check_failed' };
  } finally { clearTimeout(timer); }
  if (result.status !== 'ok') {
    try {
      reporter?.capture({ route: 'daily-preorder', reason: result.status === 'invalid' ? 'configuration_invalid' : 'check_failed',
        status: 503, duration_ms: Math.max(0, now() - started) });
      await reporter?.flush();
    } catch { /* Report failure through HTTP even if Sentry is unavailable. */ }
  }
  return res.status(result.status === 'ok' ? 200 : 503).json(result);
}
