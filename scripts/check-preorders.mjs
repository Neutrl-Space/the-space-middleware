import { pathToFileURL } from 'node:url';

const endpoint = 'https://the-space-middleware.vercel.app/api/health?check=preorders';
const codes = new Set(['invalid_preorder_flag', 'missing_or_invalid_ship_date', 'inventory_not_tracked', 'continue_selling_enabled']);
const count = value => Number.isSafeInteger(value) && value >= 0;

export async function runPreorderCheck({ env = process.env, fetchImpl = fetch, logger = console } = {}) {
  if (env.GITHUB_REF !== 'refs/heads/main' || typeof env.MONITORING_SECRET !== 'string' || env.MONITORING_SECRET.length < 32) {
    logger.error('Preorder check requires main and the monitoring-production MONITORING_SECRET secret.');
    return 1;
  }
  try {
    const response = await fetchImpl(endpoint, { method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${env.MONITORING_SECRET}` }, signal: AbortSignal.timeout(45000) });
    const body = await response.json();
    if (!['ok', 'invalid'].includes(body?.status) || !Array.isArray(body.findings) ||
        ![body.productsScanned, body.preorderProducts, body.variantsChecked, body.findingCount].every(count) ||
        typeof body.findingsTruncated !== 'boolean' ||
        (body.status === 'ok' && (!response.ok || body.findingCount !== 0 || body.findings.length || body.findingsTruncated)) ||
        (body.status === 'invalid' && (response.status !== 503 || body.findingCount === 0 || !body.findings.length))) {
      throw new Error('Audit unavailable or invalid response');
    }
    logger.log(`Catalog: ${body.productsScanned} products scanned; ${body.preorderProducts} preorder products; ${body.variantsChecked} variants checked; ${body.findingCount} findings.`);
    for (const finding of body.findings.slice(0, 100)) {
      if (!codes.has(finding.code) || !/^gid:\/\/shopify\/Product\/\d+$/.test(finding.productId || '') ||
          (finding.variantId && !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(finding.variantId))) {
        throw new Error('Invalid finding');
      }
      logger.log(JSON.stringify({ productId: finding.productId, ...(finding.variantId ? { variantId: finding.variantId } : {}), code: finding.code }));
    }
    if (body.findingsTruncated) logger.log('Only the first 100 findings are listed. Fix them and rerun.');
    return body.status === 'ok' ? 0 : 1;
  } catch {
    logger.error('Preorder audit could not be completed. Check deployment, monitoring authentication, Shopify access and service availability.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runPreorderCheck();
}
