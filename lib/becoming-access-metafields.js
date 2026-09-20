const NAMESPACE = 'becoming_access';

// Update both fields atomically. Compare-and-set prevents concurrent submissions
// and retries from replacing a newer snapshot with older preferences.
export async function syncInterestMetafields(customerId, submission, graphql) {
  const interests = submission.becoming_access_interests;
  if (!Array.isArray(interests) || !interests.length || !Number.isFinite(Date.parse(submission.created_at))) {
    throw new Error('Saved Becoming Access interests are missing.');
  }
  const snapshot = {
    submissionId: submission.id,
    submittedAt: submission.created_at,
    campaign: submission.campaign,
    interests: interests.map((item) => ({
      productId: item.product_id, productHandle: item.product_handle, productTitle: item.product_title,
      variantId: item.variant_id, variantTitle: item.variant_title, selectedSize: item.selected_size,
    })).sort((a, b) => `${a.productId}:${a.variantId || ''}`.localeCompare(`${b.productId}:${b.variantId || ''}`)),
  };
  const summary = [
    `Submitted: ${snapshot.submittedAt}`,
    ...snapshot.interests.map((item) => `${item.productTitle}${item.variantTitle ? ` — ${item.variantTitle}` : ''}${item.selectedSize ? ` (size: ${item.selectedSize})` : ''}`),
  ].join('\n');
  for (let attempt = 0; attempt < 3; attempt++) {
    const { customer } = await graphql(`query AccessPreferenceSnapshot($id: ID!) {
      customer(id: $id) {
        snapshot: metafield(namespace: "becoming_access", key: "latest_interests") { value compareDigest }
        summary: metafield(namespace: "becoming_access", key: "interest_summary") { compareDigest }
      }
    }`, { id: customerId });
    if (!customer) throw new Error('Shopify customer not found.');
    if (customer.snapshot) {
      const previous = JSON.parse(customer.snapshot.value);
      const previousTime = Date.parse(previous.submittedAt);
      if (!Number.isFinite(previousTime) || typeof previous.submissionId !== 'string') throw new Error('Unexpected preference snapshot.');
      const currentTime = Date.parse(snapshot.submittedAt);
      if (previousTime > currentTime || (previousTime === currentTime && previous.submissionId > snapshot.submissionId)) return;
    }
    const { metafieldsSet } = await graphql(`mutation SaveAccessPreferences($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { key } userErrors { field message code } }
    }`, { metafields: [
      { ownerId: customerId, namespace: NAMESPACE, key: 'latest_interests', type: 'json', value: JSON.stringify(snapshot), compareDigest: customer.snapshot?.compareDigest ?? null },
      { ownerId: customerId, namespace: NAMESPACE, key: 'interest_summary', type: 'multi_line_text_field', value: summary, compareDigest: customer.summary?.compareDigest ?? null },
    ] });
    if (metafieldsSet && !metafieldsSet.userErrors?.length) return;
    if (!metafieldsSet?.userErrors?.every((error) => error.code === 'INVALID_COMPARE_DIGEST')) break;
  }
  throw new Error('Shopify preference metafields could not be saved.');
}
