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

function buildSubmissionAlertText(submission) {
  return [
    'The Space',
    '',
    'New project submission',
    'A new project came through the site and is ready for review.',
    '',
    `Project: ${submission.project_name}`,
    `Submitted by: ${submission.name}`,
    `Email: ${submission.email}`,
    `Category: ${submission.category}`,
    `Description: ${submission.description || 'No description provided'}`,
    `Link: ${submission.link || 'No link provided'}`,
    submission.image_url ? `Image: ${submission.image_url}` : null,
    '',
    `Approve: ${process.env.MIDDLEWARE_URL}/api/projects/approve?id=${submission.id}&token=${submission.approval_token}`,
    `Reject: ${process.env.MIDDLEWARE_URL}/api/projects/reject?id=${submission.id}&token=${submission.approval_token}`,
    '',
    'Once a decision is made, the approval links will expire automatically.'
  ]
    .filter(Boolean)
    .join('\n');
}

function buildNotificationEmail({ eyebrow, heading, body, closing, accent = 'dark' }) {
  const shellColor = accent === 'light' ? '#f5f2ec' : '#111111';
  const shellText = accent === 'light' ? '#111111' : '#ffffff';
  const shellMuted = accent === 'light' ? '#5e564c' : '#d9d3c8';
  const shellLine = accent === 'light' ? '#ddd5c9' : '#2a2a2a';
  const badgeText = accent === 'light' ? '#111111' : '#f5f2ec';
  const badgeBg = accent === 'light' ? '#ece6dc' : '#1d1d1d';

  return `
    <div style="margin: 0; padding: 0; background: #f5f2ec;">
      <div style="max-width: 620px; margin: 0 auto; padding: 32px 16px 40px;">
        <div style="background: ${shellColor}; padding: 28px; border-radius: 20px; box-shadow: 0 18px 50px rgba(17, 17, 17, 0.08);">
          <div style="margin-bottom: 26px;">
            <span style="display: inline-block; width: 38px; height: 38px; line-height: 38px; text-align: center; border-radius: 12px; background: ${badgeBg}; color: ${badgeText}; font-family: Arial, Helvetica, sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.08em;">
              TS
            </span>
            <span style="display: inline-block; margin-left: 12px; vertical-align: middle; font-family: Arial, Helvetica, sans-serif; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: ${shellMuted};">
              The Space
            </span>
          </div>
          <div style="font-family: Arial, Helvetica, sans-serif; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: ${shellMuted};">
            ${escapeHtml(eyebrow)}
          </div>
          <div style="margin-top: 14px; font-family: Georgia, 'Times New Roman', serif; font-size: 34px; line-height: 1.05; font-weight: 600; color: ${shellText};">
            ${escapeHtml(heading)}
          </div>
          <div style="margin-top: 14px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.7; color: ${shellMuted};">
            ${body}
          </div>
          <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid ${shellLine}; font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.7; color: ${shellMuted};">
            ${closing}
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildSubmissionConfirmationEmailHtml(submission) {
  return buildNotificationEmail({
    eyebrow: 'Submission received',
    heading: 'Your submission is in',
    body: `
      <p style="margin: 0 0 14px;">Hi ${escapeHtml(submission.name)},</p>
      <p style="margin: 0;">We have received your submission for <strong>${escapeHtml(submission.project_name)}</strong> and it is currently under review.</p>
    `,
    closing: 'We will be in touch soon. <span style="display:block; margin-top: 10px; color: inherit;">The Space Team</span>',
    accent: 'light'
  });
}

function buildApprovedEmailHtml(submission) {
  return buildNotificationEmail({
    eyebrow: 'Approved',
    heading: 'Welcome to the Space',
    body: `
      <p style="margin: 0 0 14px;">Hi ${escapeHtml(submission.name)},</p>
      <p style="margin: 0;">Great news - <strong>${escapeHtml(submission.project_name)}</strong> has been approved and is now live on The Space.</p>
      <p style="margin: 14px 0 0;">Welcome to the Space.</p>
    `,
    closing: 'We are glad to have your work here. <span style="display:block; margin-top: 10px; color: inherit;">The Space Team</span>',
    accent: 'dark'
  });
}

function buildRejectedEmailHtml(submission) {
  return buildNotificationEmail({
    eyebrow: 'Reviewed',
    heading: 'Update on your submission',
    body: `
      <p style="margin: 0 0 14px;">Hi ${escapeHtml(submission.name)},</p>
      <p style="margin: 0;">Thank you for submitting <strong>${escapeHtml(submission.project_name)}</strong> to The Space. After review, we are unable to feature it at this time.</p>
      <p style="margin: 14px 0 0;">We appreciate the time and care you put into your work.</p>
    `,
    closing: 'Thank you for sharing it with us. <span style="display:block; margin-top: 10px; color: inherit;">The Space Team</span>',
    accent: 'light'
  });
}

// Core send function
async function sendEmail({ to, subject, html, text }) {
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
      html,
      text,
      replyTo: gmailUser
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
    subject: `New submission: ${submission.project_name}`,
    html: buildSubmissionAlertEmail(submission),
    text: buildSubmissionAlertText(submission)
  });
}

// 2. Sent to the submitter confirming their submission was received
async function sendSubmissionConfirmationEmail(submission) {
  const text = [
    'Thanks for your submission',
    '',
    `Hi ${submission.name},`,
    '',
    `We have received your submission for ${submission.project_name} and it is currently under review.`,
    'We will be in touch soon.',
    '',
    'The Space Team'
  ].join('\n');

  await sendEmail({
    to: submission.email,
    subject: `We received your submission for ${submission.project_name}`,
    html: buildSubmissionConfirmationEmailHtml(submission),
    text
  });
}

// 3. Sent to the submitter when their project is approved
async function sendApprovedEmail(submission) {
  const text = [
    'Welcome to the Space',
    '',
    `Hi ${submission.name},`,
    '',
    `Great news — ${submission.project_name} has been approved and is now live on The Space.`,
    'Welcome to the Space.',
    '',
    'The Space Team'
  ].join('\n');

  await sendEmail({
    to: submission.email,
    subject: `Your submission was approved: ${submission.project_name}`,
    html: buildApprovedEmailHtml(submission),
    text
  });
}

// 4. Sent to the submitter when their project is rejected
async function sendRejectedEmail(submission) {
  const text = [
    'Update on your submission',
    '',
    `Hi ${submission.name},`,
    '',
    `Thank you for submitting ${submission.project_name} to The Space. After review we are unable to feature it at this time.`,
    'We appreciate you sharing your work with us.',
    '',
    'The Space Team'
  ].join('\n');

  await sendEmail({
    to: submission.email,
    subject: `Update on your submission: ${submission.project_name}`,
    html: buildRejectedEmailHtml(submission),
    text
  });
}

module.exports = {
  buildSubmissionAlertEmail,
  buildSubmissionConfirmationEmailHtml,
  buildApprovedEmailHtml,
  buildRejectedEmailHtml,
  sendNewSubmissionAlert,
  sendSubmissionConfirmationEmail,
  sendApprovedEmail,
  sendRejectedEmail
};
