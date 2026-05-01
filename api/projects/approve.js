// GET/POST — approve a submission
import email from '../../lib/email';
import shopify from '../../lib/shopify';
import supabase from '../../lib/supabase';

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { id, token } = req.method === 'GET' ? req.query : req.body || {};
    const submissionId = Array.isArray(id) ? id[0] : id;
    const approvalToken = Array.isArray(token) ? token[0] : token;
    const isAdminRequest =
      req.method === 'POST' &&
      req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;

    if (!submissionId) {
      return res.status(400).send('Invalid approval link.');
    }

    let query = supabase
      .from('project_submissions')
      .select('id, name, email, project_name, description, category, image_url, status, approval_token')
      .eq('id', submissionId);

    if (!isAdminRequest) {
      if (!approvalToken) {
        return res.status(400).send('Invalid approval link.');
      }

      query = query.eq('approval_token', approvalToken);
    }

    const { data: submission, error: fetchError } = await query.single();
    if (fetchError || !submission) {
      return res.status(404).send('Submission not found or invalid token.');
    }

    if (submission.status !== 'pending') {
      return res.status(200).send(`
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 60px;">
          <h2>Already Reviewed</h2>
          <p>This submission has already been ${submission.status}.</p>
          <p style="color: #999;">No further action is needed.</p>
        </div>
      `);
    }

    await shopify.upsertApprovedProjectMetaobject({
      ...submission,
      link: submission.link || ''
    });

    const { error: updateError } = await supabase
      .from('project_submissions')
      .update({
        status: 'approved',
        reviewed_at: new Date().toISOString()
      })
      .eq('id', submissionId);

    if (updateError) {
      throw updateError;
    }

    try {
      await email.sendApprovedEmail(submission);
    } catch (emailError) {
      await supabase
        .from('project_submissions')
        .update({
          status: 'pending',
          reviewed_at: null
        })
        .eq('id', submissionId);

      throw emailError;
    }

    return res.status(200).send(`
      <div style="font-family: Arial, sans-serif; text-align: center; padding: 60px;">
        <h2>Approved</h2>
        <p><strong>${submission.project_name}</strong> has been approved and is now live on The Space.</p>
        <p style="color: #999;">You can close this tab.</p>
      </div>
    `);
  } catch (error) {
    console.error('Approve error:', error);
    return res.status(500).send('Something went wrong.');
  }
};
