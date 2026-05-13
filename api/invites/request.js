import email from '../../lib/email';

function parseJsonRequest(req) {
  return new Promise((resolve, reject) => {
    let rawBody = '';

    req.on('data', (chunk) => {
      rawBody += chunk;
    });

    req.on('end', () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = await parseJsonRequest(req);
    const name = String(body.name || '').trim();
    const emailAddress = normalizeEmail(body.email);
    const handle = String(body.handle || '').trim();
    const note = String(body.note || '').trim();

    if (!name || !emailAddress) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!emailAddress.includes('@') || !emailAddress.includes('.')) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const invite = {
      name,
      email: emailAddress,
      handle,
      note
    };

    await Promise.all([
      email.sendInviteRequestAlert(invite),
      email.sendInvitePendingEmail(invite)
    ]);

    return res.status(200).json({
      success: true,
      message: 'Invite request submitted'
    });
  } catch (error) {
    console.error('Invite request failed:', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Invite request failed'
    });
  }
};
