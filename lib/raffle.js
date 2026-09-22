import { randomInt } from 'node:crypto';

export function createRaffleHandler({ db, env = process.env, number = () => randomInt(100000, 1000000) }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    const origins = (env.POPUP_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!origins.includes(req.headers.origin)) return res.status(403).json({ error: 'Origin not allowed.' });
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'Method not allowed.' }); }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({ error: 'Send JSON.' });
    if (!env.RAFFLE_EVENT_ID || env.RAFFLE_ENTRIES_OPEN !== 'true') return res.status(503).json({ error: 'Raffle entries are closed.' });
    let body;
    try {
      let raw;
      if (req.body !== undefined) raw = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
      else {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > 4096) return res.status(413).json({ error: 'Request too large.' });
          chunks.push(buffer);
        }
        raw = Buffer.concat(chunks).toString('utf8');
      }
      if (Buffer.byteLength(raw) > 4096) return res.status(413).json({ error: 'Request too large.' });
      body = JSON.parse(raw);
    } catch { return res.status(400).json({ error: 'Invalid JSON.' }); }
    if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120 ||
      typeof body.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.requestId) || body.eventId !== env.RAFFLE_EVENT_ID) {
      return res.status(400).json({ error: 'Check your name and event link.' });
    }
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const { data, error } = await db.rpc('register_raffle_entry', {
          p_event_id: env.RAFFLE_EVENT_ID, p_request_id: body.requestId, p_name: body.name.trim(), p_number: number(),
        });
        if (error?.code === '23505') continue;
        if (error || !/^[1-9]\d{5}$/.test(String(data?.number)) || typeof data?.name !== 'string') throw new Error('Entry could not be saved.');
        return res.status(200).json({ success: true, entry: { name: data.name, number: data.number } });
      }
      throw new Error('No number allocated.');
    } catch { return res.status(503).json({ error: 'Unable to issue an entry. Please retry.' }); }
  };
}
