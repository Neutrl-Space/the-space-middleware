import {createHmac, timingSafeEqual} from 'node:crypto';

export function createCancellationHandler({supabase, env = process.env, logger = console}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({success:false});
    }
    const secret = env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_CLIENT_SECRET;
    const shop = String(env.SHOPIFY_SHOP || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/\.myshopify\.com$/, '');
    if (!secret || !shop) return res.status(503).json({success:false});
    try {
      // Read the original bytes. Never reconstruct signed JSON from req.body.
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 2 * 1024 * 1024) return res.status(413).json({success:false});
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks);
      const header = req.headers['x-shopify-hmac-sha256'];
      if (typeof header !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(header)) return res.status(401).json({success:false});
      const signature = Buffer.from(header, 'base64');
      const expected = createHmac('sha256', secret).update(raw).digest();
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return res.status(401).json({success:false});
      if (req.headers['x-shopify-shop-domain'] !== `${shop}.myshopify.com`) return res.status(403).json({success:false});
      if (req.headers['x-shopify-topic'] !== 'orders/cancelled') return res.status(400).json({success:false});
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); }
      catch { return res.status(400).json({success:false}); }
      if (!payload || typeof payload !== 'object') return res.status(400).json({success:false});
      let orderId = payload.admin_graphql_api_id;
      if (!orderId && (typeof payload.id === 'string' || Number.isSafeInteger(payload.id)) && /^[1-9]\d*$/.test(String(payload.id))) {
        orderId = `gid://shopify/Order/${payload.id}`;
      }
      const cancelledAt = payload.cancelled_at;
      if (typeof orderId !== 'string' || !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(orderId) ||
          typeof cancelledAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(cancelledAt) || !Number.isFinite(Date.parse(cancelledAt))) {
        return res.status(400).json({success:false});
      }
      // The condition makes duplicate deliveries a no-op, preserving original audit timestamps.
      const {data, error} = await supabase.from('event_orders').update({
        status: 'cancelled', cancelled_at: new Date(cancelledAt).toISOString(), updated_at: new Date().toISOString(),
      }).eq('shopify_order_id', orderId).neq('status', 'cancelled').select('id');
      if (error) throw new Error('Cancellation update failed');
      if (data?.length) return res.status(200).json({success:true});
      const existing = await supabase.from('event_orders').select('id').eq('shopify_order_id', orderId).maybeSingle();
      if (existing.error) throw new Error('Cancellation lookup failed');
      if (existing.data) return res.status(200).json({success:true});
      const tags = typeof payload.tags === 'string' ? payload.tags.split(',').map(tag => tag.trim()) : [];
      const popup = tags.some(tag => ['SOHO_POPUP', 'QR_RESERVATION', 'soho-popup'].includes(tag) || tag.startsWith('popup-request-'));
      if (popup) {
        // Cancellation can arrive before the reservation insert finishes. Ask Shopify to retry.
        logger.error('popup_cancellation_record_missing', {orderId});
        return res.status(503).json({success:false});
      }
      return res.status(200).json({success:true, ignored:true});
    } catch {
      logger.error('popup_cancellation_sync_failed');
      return res.status(503).json({success:false});
    }
  };
}
