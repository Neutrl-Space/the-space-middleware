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
    allowStatus(clientKey, tokenKey) {
      return rpc('allow_newsletter_status', { client_key: clientKey, token_key: tokenKey });
    },
    claimCustomer(config, customerId) {
      return rpc('claim_newsletter_customer_job', { shop_domain: config.shop, campaign_name: config.campaign, customer_gid: customerId });
    },
    async assignment(config, customerId) {
      const { data, error } = await db.from('newsletter_assignments').select('*')
        .eq('shop', config.shop).eq('campaign', config.campaign).eq('customer_id', customerId).maybeSingle();
      if (error) throw new Error('Newsletter assignment lookup failed.');
      return data;
    },
    claimReminder(config) {
      return rpc('claim_newsletter_reminder', { shop_domain: config.shop, campaign_name: config.campaign });
    },
    finishReminder(job, outcome, explanation = null) {
      return rpc('finish_newsletter_reminder', { job_id: job.id, token: job.reminder_lease_token, outcome, explanation });
    },
    async checkReminderLease(job) {
      const { data, error } = await db.from('newsletter_assignments').select('status, revocation_requested, redeemed_order_id')
        .eq('id', job.id).eq('reminder_lease_token', job.reminder_lease_token).single();
      if (error || !data || data.status !== 'published' || data.revocation_requested || data.redeemed_order_id) {
        throw new Error('Newsletter reminder interrupted.');
      }
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
    fail(job, reason = 'processing_failed') {
      return this.finish(job, { status: 'pending', reason });
    },
  };
}
