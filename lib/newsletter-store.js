export function createNewsletterStore(db) {
  async function rpc(name, args) {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error(`Newsletter ${name} failed.`);
    return data;
  }
  return {
    async requireReady(config) {
      const { data, error } = await db.from('newsletter_campaigns').select('baseline_completed_at')
        .eq('shop', config.shop).eq('campaign', config.campaign).single();
      if (error || !data?.baseline_completed_at) throw new Error('Newsletter baseline is not complete.');
    },
    enqueue(event, config) {
      return rpc('enqueue_newsletter_event', { event_data: event, campaign_name: config.campaign, campaign_rules: config.rules });
    },
    claim(config) {
      return rpc('claim_newsletter_job', { shop_domain: config.shop, campaign_name: config.campaign });
    },
    async reserve(job, fields) {
      const { data, error } = await db.from('newsletter_assignments').update(fields)
        .eq('id', job.id).eq('lease_token', job.lease_token).is('code', null).select().single();
      if (error || !data) throw new Error('Newsletter reservation failed.');
      return data;
    },
    async checkLease(job) {
      const { data, error } = await db.from('newsletter_assignments').select('revocation_requested, redeemed_order_id')
        .eq('id', job.id).eq('lease_token', job.lease_token).single();
      if (error || !data || data.revocation_requested || data.redeemed_order_id) throw new Error('Newsletter processing interrupted.');
    },
    finish(job, fields) {
      return rpc('finish_newsletter_job', { job_id: job.id, token: job.lease_token, changes: fields });
    },
    fail(job) {
      return this.finish(job, { status: 'pending', reason: 'processing_failed' });
    },
  };
}
