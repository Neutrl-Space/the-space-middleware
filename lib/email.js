const nodemailer = require('nodemailer');

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
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">New Project Submission</h2>
        <p>A new project has been submitted and is awaiting review.</p>

        <table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
          <tr>
            <td style="padding: 10px; font-weight: bold; color: #555; width: 140px; background: #f9f9f9;">Project</td>
            <td style="padding: 10px;">${submission.project_name}</td>
          </tr>
          <tr>
            <td style="padding: 10px; font-weight: bold; color: #555; background: #f9f9f9;">Submitted by</td>
            <td style="padding: 10px;">${submission.name}</td>
          </tr>
          <tr>
            <td style="padding: 10px; font-weight: bold; color: #555; background: #f9f9f9;">Email</td>
            <td style="padding: 10px;">${submission.email}</td>
          </tr>
          <tr>
            <td style="padding: 10px; font-weight: bold; color: #555; background: #f9f9f9;">Category</td>
            <td style="padding: 10px;">${submission.category}</td>
          </tr>
          <tr>
            <td style="padding: 10px; font-weight: bold; color: #555; background: #f9f9f9;">Description</td>
            <td style="padding: 10px;">${submission.description || 'No description provided'}</td>
          </tr>
          <tr>
            <td style="padding: 10px; font-weight: bold; color: #555; background: #f9f9f9;">Link</td>
            <td style="padding: 10px;">
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
            ? `<img src="${submission.image_url}"
               style="width: 100%; max-width: 500px; border-radius: 8px; margin-bottom: 24px;" />`
            : ''
        }

        <div style="margin: 32px 0; text-align: center;">
          <a href="${process.env.MIDDLEWARE_URL}/api/projects/approve?id=${submission.id}&token=${submission.approval_token}"
            style="background: #1a1a1a; color: white; padding: 14px 32px;
                   text-decoration: none; border-radius: 4px; margin-right: 16px;
                   font-weight: bold; display: inline-block;">
            Approve
          </a>
          <a href="${process.env.MIDDLEWARE_URL}/api/projects/reject?id=${submission.id}&token=${submission.approval_token}"
            style="background: white; color: #1a1a1a; padding: 14px 32px;
                   text-decoration: none; border-radius: 4px;
                   font-weight: bold; display: inline-block;
                   border: 2px solid #1a1a1a;">
            Reject
          </a>
        </div>

        <p style="color: #999; font-size: 12px; text-align: center;">
          Once actioned the buttons will no longer work.
        </p>
      </div>
    `
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
  sendNewSubmissionAlert,
  sendSubmissionConfirmationEmail,
  sendApprovedEmail,
  sendRejectedEmail
};
