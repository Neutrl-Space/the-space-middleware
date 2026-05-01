const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MIDDLEWARE_URL = process.env.MIDDLEWARE_URL;

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`
    },
    body: JSON.stringify({
      // from: 'The Space <noreply@thespace.com>',
      from: 'The Space <onboarding@resend.dev>',

      to: Array.isArray(to) ? to : [to],
      subject,
      html
    })
  });

  if (!response.ok) {
    throw new Error(`Email error: ${await response.text()}`);
  }
}

async function sendApprovalRequestEmail(submission) {
  const teamEmails = (process.env.TEAM_EMAILS || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);

  if (!MIDDLEWARE_URL || teamEmails.length === 0) {
    throw new Error('MIDDLEWARE_URL or TEAM_EMAILS is not set');
  }

  const approveUrl = `${MIDDLEWARE_URL}/api/projects/approve?id=${submission.id}&token=${submission.approval_token}`;
  const rejectUrl = `${MIDDLEWARE_URL}/api/projects/reject?id=${submission.id}&token=${submission.approval_token}`;

  await sendEmail({
    to: teamEmails,
    subject: `New Project Submission — ${submission.project_name}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">New Project Submission</h2>
        <p>A new project has been submitted to The Space and is awaiting review.</p>

        <table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
          <tr>
            <td style="padding: 8px; font-weight: bold; color: #555; width: 140px;">Project</td>
            <td style="padding: 8px;">${submission.project_name}</td>
          </tr>
          <tr style="background: #f9f9f9;">
            <td style="padding: 8px; font-weight: bold; color: #555;">Submitted by</td>
            <td style="padding: 8px;">${submission.name}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; color: #555;">Email</td>
            <td style="padding: 8px;">${submission.email}</td>
          </tr>
          <tr style="background: #f9f9f9;">
            <td style="padding: 8px; font-weight: bold; color: #555;">Category</td>
            <td style="padding: 8px;">${submission.category}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; color: #555;">Address</td>
            <td style="padding: 8px;">${submission.address || 'No address provided'}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; color: #555;">Description</td>
            <td style="padding: 8px;">${submission.description || 'No description provided'}</td>
          </tr>
          <tr style="background: #f9f9f9;">
            <td style="padding: 8px; font-weight: bold; color: #555;">Link</td>
            <td style="padding: 8px;">
              ${
                submission.link
                  ? `<a href="${submission.link}">${submission.link}</a>`
                  : 'No link provided'
              }
            </td>
          </tr>
        </table>

        ${
          submission.image_url
            ? `<img src="${submission.image_url}" style="width: 100%; max-width: 500px; border-radius: 8px; margin-bottom: 24px;" />`
            : ''
        }

        <div style="margin: 32px 0; text-align: center;">
          <a href="${approveUrl}"
            style="background: #1a1a1a; color: white; padding: 14px 32px;
                   text-decoration: none; border-radius: 4px; margin-right: 16px;
                   font-weight: bold; display: inline-block;">
            Approve
          </a>
          <a href="${rejectUrl}"
            style="background: white; color: #1a1a1a; padding: 14px 32px;
                   text-decoration: none; border-radius: 4px;
                   font-weight: bold; display: inline-block;
                   border: 2px solid #1a1a1a;">
            Reject
          </a>
        </div>

        <p style="color: #999; font-size: 12px; text-align: center;">
          Only one team member needs to action this. Once approved or rejected the buttons will no longer work.
        </p>
      </div>
    `
  });
}

async function sendSubmissionConfirmationEmail(submission) {
  await sendEmail({
    to: submission.email,
    subject: `We received your submission — ${submission.project_name}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">Thanks for your submission</h2>
        <p>Hi ${submission.name},</p>
        <p>We have received your submission for <strong>${submission.project_name}</strong>
           and it is currently under review. We will be in touch soon.</p>
        <p style="color: #555;">The Space Team</p>
      </div>
    `
  });
}

async function sendApprovedEmail(submission) {
  await sendEmail({
    to: submission.email,
    subject: `Your project has been approved — ${submission.project_name}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">Your project has been approved</h2>
        <p>Hi ${submission.name},</p>
        <p>Great news — <strong>${submission.project_name}</strong> has been approved
           and is now live on The Space.</p>
        <p style="color: #555;">The Space Team</p>
      </div>
    `
  });
}

async function sendRejectedEmail(submission) {
  await sendEmail({
    to: submission.email,
    subject: `Update on your submission — ${submission.project_name}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">Update on your submission</h2>
        <p>Hi ${submission.name},</p>
        <p>Thank you for submitting <strong>${submission.project_name}</strong> to The Space.
           After review we are unable to feature it at this time.</p>
        <p>We appreciate you sharing your work with us.</p>
        <p style="color: #555;">The Space Team</p>
      </div>
    `
  });
}

module.exports = {
  sendApprovalRequestEmail,
  sendSubmissionConfirmationEmail,
  sendApprovedEmail,
  sendRejectedEmail
};
