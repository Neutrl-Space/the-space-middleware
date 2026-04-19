// POST — admin rejects a submission
import { from } from '../../lib/supabase';
import { triggerKlaviyoEvent } from '../../lib/klaviyo';

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing submission ID' });

    const { data: submission, error: fetchError } = await from(
      'project_submissions'
    )
      .select('email, project_name, name')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    const { error: updateError } = await from('project_submissions')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
      .eq('id', id);

    if (updateError) throw updateError;

    await triggerKlaviyoEvent('Project Rejected', submission.email, {
      project_name: submission.project_name,
      name: submission.name
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Reject error:', error);
    return res.status(500).json({ error: 'Something went wrong' });
  }
};
