const ORIGIN = 'https://neutrlspaceny.com';
const CATALOG = `query MonitoringPublishedProducts($after: String) {
  products(first: 50, after: $after, sortKey: ID) {
    nodes { id handle status onlineStoreUrl }
    pageInfo { hasNextPage endCursor }
  }
}`;

function allowedUrl(url, handle) {
  return url.protocol === 'https:' && ['neutrlspaceny.com', 'www.neutrlspaceny.com'].includes(url.hostname) &&
    !url.port && !url.username && !url.password && !url.search && !url.hash &&
    url.pathname === `/products/${handle}`;
}

async function catalog(graphql, signal) {
  const handles = [], cursors = new Set(), seen = new Set();
  let after = null;
  for (let page = 0; page < 20; page++) {
    signal.throwIfAborted();
    const data = await graphql(CATALOG, { after }, { signal });
    const connection = data?.products;
    if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw new Error('Incomplete catalog');
    for (const product of connection.nodes) {
      if (!product || !['ACTIVE', 'UNLISTED', 'DRAFT', 'ARCHIVED'].includes(product.status) ||
          !/^[a-z0-9][a-z0-9-]{0,254}$/.test(product.handle || '') ||
          !/^gid:\/\/shopify\/Product\/\d+$/.test(product.id || '') || seen.has(product.id)) throw new Error('Incomplete product');
      seen.add(product.id);
      if (['DRAFT', 'ARCHIVED'].includes(product.status) || product.onlineStoreUrl === null) continue;
      if (typeof product.onlineStoreUrl !== 'string' || !allowedUrl(new URL(product.onlineStoreUrl), product.handle)) throw new Error('Unexpected storefront URL');
      handles.push(product.handle);
    }
    if (!connection.pageInfo.hasNextPage) {
      if (!handles.length) throw new Error('No published products');
      return handles;
    }
    after = connection.pageInfo.endCursor;
    if (typeof after !== 'string' || !after || cursors.has(after)) throw new Error('Incomplete pagination');
    cursors.add(after);
  }
  throw new Error('Catalog scan limit exceeded');
}

async function checkPage(handle, fetchImpl, signal) {
  let url = new URL(`/products/${handle}`, ORIGIN);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
  try {
    // Follow only same-product HTTPS redirects on our public domain. No secrets
    // or monitoring authorization headers are forwarded to the storefront.
    for (let redirects = 0; redirects <= 3; redirects++) {
      timeout.throwIfAborted();
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: timeout });
      const location = response.headers.get('location');
      await response.body?.cancel();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = location && new URL(location, url);
        if (!next || !allowedUrl(next, handle)) throw new Error('Unexpected redirect');
        url = next;
        continue;
      }
      return { handle, status: response.status === 200 ? 'up' : 'down', httpStatus: response.status };
    }
  } catch { /* A failed page is reported without raw URLs/errors/headers. */ }
  return { handle, status: 'down', httpStatus: 0 };
}

export async function checkProductPages({ graphql, fetchImpl = fetch, signal }) {
  const handles = await catalog(graphql, signal);
  const pages = new Array(handles.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, handles.length) }, async () => {
    while (next < handles.length) {
      signal.throwIfAborted();
      const index = next++;
      pages[index] = await checkPage(handles[index], fetchImpl, signal);
    }
  }));
  signal.throwIfAborted();
  const failed = pages.filter(page => page.status !== 'up');
  return { status: failed.length ? 'degraded' : 'ok', productsChecked: pages.length,
    failedCount: failed.length, failures: failed.slice(0, 100), failuresTruncated: failed.length > 100 };
}

export async function serveProductPagesCheck({ graphql, fetchImpl, res, timeoutMs = 20000 }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let timer;
  let result;
  try {
    result = await Promise.race([
      checkProductPages({ graphql, fetchImpl, signal }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Scan timed out')), timeoutMs); }),
    ]);
  } catch {
    result = { status: 'check_failed' };
  } finally { clearTimeout(timer); }
  return res.status(result.status === 'ok' ? 200 : 503).json(result);
}
