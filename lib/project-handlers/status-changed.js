//POST — receives Supabase webhook
export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;

    // Supabase sends the old and new record in the webhook payload
    const newRecord = payload.record;
    const oldRecord = payload.old_record;

    // Only act if status actually changed
    if (newRecord.status === oldRecord.status) {
      return res.status(200).json({ message: 'No status change' });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Something went wrong' });
  }
};
