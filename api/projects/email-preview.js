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

  const html = email.buildSubmissionAlertEmail(sampleSubmission);

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
        </style>
      </head>
      <body>
        ${html}
      </body>
    </html>
  `);
};
