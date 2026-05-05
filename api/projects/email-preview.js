import email from '../../lib/email';

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const sampleSubmission = {
    id: 'preview',
    approval_token: 'preview-token',
    name: 'Ari Stone',
    email: 'ari@example.com',
    project_name: 'Midnight Garden',
    description:
      'An atmospheric concept piece blending fashion, space, and quiet editorial storytelling.',
    category: 'art/creative project',
    image_url:
      'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=1400&q=80',
    link: 'https://example.com/project'
  };

  const previewType = String(req.query?.type || 'all').toLowerCase();

  const sections = [];

  if (previewType === 'team' || previewType === 'all') {
    sections.push(`
      <section style="margin-bottom: 36px;">
        <div style="margin: 0 0 12px; font-family: Arial, Helvetica, sans-serif; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: #6b6b6b;">Team alert</div>
        ${email.buildSubmissionAlertEmail(sampleSubmission)}
      </section>
    `);
  }

  if (previewType === 'confirmation' || previewType === 'all') {
    sections.push(`
      <section style="margin-bottom: 36px;">
        <div style="margin: 0 0 12px; font-family: Arial, Helvetica, sans-serif; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: #6b6b6b;">Confirmation</div>
        ${email.buildSubmissionConfirmationEmailHtml(sampleSubmission)}
      </section>
    `);
  }

  if (previewType === 'approval' || previewType === 'all') {
    sections.push(`
      <section style="margin-bottom: 36px;">
        <div style="margin: 0 0 12px; font-family: Arial, Helvetica, sans-serif; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: #6b6b6b;">Approval</div>
        ${email.buildApprovedEmailHtml(sampleSubmission)}
      </section>
    `);
  }

  if (previewType === 'rejection' || previewType === 'all') {
    sections.push(`
      <section style="margin-bottom: 36px;">
        <div style="margin: 0 0 12px; font-family: Arial, Helvetica, sans-serif; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: #6b6b6b;">Rejection</div>
        ${email.buildRejectedEmailHtml(sampleSubmission)}
      </section>
    `);
  }

  return res.status(200).send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>The Space Email Preview</title>
        <style>
          html, body {
            margin: 0;
            padding: 0;
            background: #f5f2ec;
          }
          .wrap {
            max-width: 740px;
            margin: 0 auto;
            padding: 28px 16px 50px;
          }
          .title {
            margin: 0 0 12px;
            font-family: Arial, Helvetica, sans-serif;
            font-size: 12px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: #6b6b6b;
          }
          .hero {
            margin: 0 0 28px;
            font-family: Georgia, 'Times New Roman', serif;
            font-size: 28px;
            line-height: 1.1;
            color: #111111;
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="title">Email preview</div>
          <h1 class="hero">The Space notification set</h1>
          ${sections.join('')}
        </div>
      </body>
    </html>
  `);
};
