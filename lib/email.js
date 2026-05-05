const nodemailer = require('nodemailer');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatLink(value) {
  const safeValue = String(value ?? '').trim();

  if (!safeValue) return 'No link provided';

  return `<a href="${escapeHtml(safeValue)}" style="color: #111111; text-decoration: underline; word-break: break-word;">${escapeHtml(safeValue)}</a>`;
}

function buildSubmissionDetailRow(label, value) {
  return `
    <tr>
      <td style="padding: 12px 0; width: 150px; vertical-align: top; color: #6b6b6b; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; border-bottom: 1px solid #ece7df;">
        ${escapeHtml(label)}
      </td>
      <td style="padding: 12px 0; vertical-align: top; color: #111111; font-size: 15px; line-height: 1.6; border-bottom: 1px solid #ece7df;">
        ${value}
      </td>
    </tr>
  `;
}

function buildSubmissionAlertEmail(submission) {
  const approvalUrl = `${process.env.MIDDLEWARE_URL}/api/projects/approve?id=${submission.id}&token=${submission.approval_token}`;
  const rejectUrl = `${process.env.MIDDLEWARE_URL}/api/projects/reject?id=${submission.id}&token=${submission.approval_token}`;
  const hasImage = Boolean(submission.image_url);

  return `
    <div style="margin: 0; padding: 0; background: #f5f2ec;">
      <div style="max-width: 680px; margin: 0 auto; padding: 32px 16px 40px;">
        <div style="background: #111111; padding: 24px 28px; border-radius: 18px 18px 0 0;">
          <div style="color: #f5f2ec; font-family: Arial, Helvetica, sans-serif; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;">
            The Space
          </div>
          <div style="margin-top: 14px; color: #ffffff; font-family: Georgia, 'Times New Roman', serif; font-size: 34px; line-height: 1.05; font-weight: 600;">
            New project submission
          </div>
          <div style="margin-top: 12px; color: #c8c2b8; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; max-width: 500px;">
            A new project came through the site and is ready for review.
          </div>
        </div>

        <div style="background: #ffffff; border: 1px solid #e6dfd4; border-top: 0; border-radius: 0 0 18px 18px; overflow: hidden; box-shadow: 0 18px 50px rgba(17, 17, 17, 0.08);">
          <div style="padding: 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
              ${buildSubmissionDetailRow('Project', escapeHtml(submission.project_name))}
              ${buildSubmissionDetailRow('Submitted by', escapeHtml(submission.name))}
              ${buildSubmissionDetailRow('Email', `<a href="mailto:${escapeHtml(submission.email)}" style="color: #111111; text-decoration: none;">${escapeHtml(submission.email)}</a>`)}
              ${buildSubmissionDetailRow('Category', escapeHtml(submission.category))}
              ${buildSubmissionDetailRow('Description', escapeHtml(submission.description || 'No description provided'))}
              ${buildSubmissionDetailRow('Link', formatLink(submission.link))}
            </table>

            ${
              hasImage
                ? `
                  <div style="margin-top: 28px;">
                    <div style="margin-bottom: 10px; color: #6b6b6b; font-family: Arial, Helvetica, sans-serif; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;">
                      Image preview
                    </div>
                    <div style="border: 1px solid #e6dfd4; border-radius: 14px; overflow: hidden; background: #f8f6f1;">
                      <img src="${escapeHtml(submission.image_url)}" alt="Submission image for ${escapeHtml(submission.project_name)}" style="display: block; width: 100%; max-width: 100%; height: auto;" />
                    </div>
                  </div>
                `
                : ''
            }

            <div style="margin-top: 30px; display: block;">
              <a href="${approvalUrl}"
                 style="display: inline-block; background: #111111; color: #ffffff; text-decoration: none; padding: 14px 24px; border-radius: 999px; font-family: Arial, Helvetica, sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-right: 12px; margin-bottom: 10px;">
                Approve
              </a>
              <a href="${rejectUrl}"
                 style="display: inline-block; background: #ffffff; color: #111111; text-decoration: none; padding: 14px 24px; border-radius: 999px; font-family: Arial, Helvetica, sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; border: 1px solid #111111; margin-bottom: 10px;">
                Reject
              </a>
            </div>
          </div>

          <div style="padding: 18px 28px 26px; border-top: 1px solid #ece7df; color: #8a847b; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.6;">
            Once a decision is made, the approval links will expire automatically.
          </div>
        </div>
      </div>
    </div>
  `;
}

// Core send function
async function sendEmail({ to, subject, html }) {
  try {
    const gmailUser = process.env.GMAIL_USER;
    const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

    if (!gmailUser || !gmailAppPassword) {
      const error = new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set');
      error.statusCode = 500;
      throw error;
    }

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: gmailUser,
        pass: gmailAppPassword
      }
    });

    await transporter.sendMail({
      from: `"The Space" <${gmailUser}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      html
    });
    console.log(`Email sent to ${to} — ${subject}`);
  } catch (error) {
    console.error('Email sending failed:', error.message);
    throw error;
  }
}

// 1. Sent to the shared inbox when a new project is submitted
async function sendNewSubmissionAlert(submission) {
  await sendEmail({
    to: process.env.GMAIL_USER,
    subject: `New Project Submission — ${submission.project_name}`,
    html: buildSubmissionAlertEmail(submission)
  });
}

// 2. Sent to the submitter confirming their submission was received
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
        <br/>
        <p style="color: #555;">The Space Team</p>
      </div>
    `
  });
}

// 3. Sent to the submitter when their project is approved
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
        <br/>
        <p style="color: #555;">The Space Team</p>
      </div>
    `
  });
}

// 4. Sent to the submitter when their project is rejected
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
        <br/>
        <p style="color: #555;">The Space Team</p>
      </div>
    `
  });
}

module.exports = {
  buildSubmissionAlertEmail,
  sendNewSubmissionAlert,
  sendSubmissionConfirmationEmail,
  sendApprovedEmail,
  sendRejectedEmail
};
