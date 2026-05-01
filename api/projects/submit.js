// POST — receives form submission
import { randomBytes } from 'crypto';
import Busboy from 'busboy';
import email from '../../lib/email';
import supabase from '../../lib/supabase';

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET;

export const config = {
  api: {
    bodyParser: false
  }
};

function parseMultipartRequest(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let uploadedFile = null;
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: 5 * 1024 * 1024
      }
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (fieldname, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];

      file.on('data', (chunk) => {
        chunks.push(chunk);
      });

      file.on('limit', () => {
        reject(new Error('Image file is too large. Max 5MB allowed.'));
      });

      file.on('end', () => {
        if (!filename) return;
        uploadedFile = {
          fieldname,
          filename,
          mimeType,
          buffer: Buffer.concat(chunks)
        };
      });
    });

    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, uploadedFile }));

    req.pipe(busboy);
  });
}

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

async function parseSubmissionRequest(req) {
  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    return parseMultipartRequest(req);
  }

  return { fields: await parseJsonRequest(req), uploadedFile: null };
}

async function uploadSubmissionImage(uploadedFile) {
  if (!uploadedFile) return null;

  if (!STORAGE_BUCKET) {
    throw new Error('SUPABASE_STORAGE_BUCKET is not set');
  }

  if (!uploadedFile.mimeType?.startsWith('image/')) {
    throw new Error('Uploaded file must be an image');
  }

  const extension = uploadedFile.filename?.split('.').pop()?.toLowerCase() || 'jpg';
  const path = `submissions/${Date.now()}-${randomBytes(8).toString('hex')}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, uploadedFile.buffer, {
      contentType: uploadedFile.mimeType,
      upsert: false
    });

  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return { image_url: data.publicUrl, storage_path: path };
}

export default async (req, res) => {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fields, uploadedFile } = await parseSubmissionRequest(req);
    const {
      name,
      email: rawEmail,
      project_name,
      description,
      category,
      image_url,
      link
    } = fields;
    const normalizedEmail = rawEmail?.trim().toLowerCase();

    // Validate required fields
    if (!name || !rawEmail || !project_name || !category) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate category is one of the allowed values
    const allowedCategories = [
      'music/event',
      'art/creative project',
      'place',
      'brand/business',
      'other'
    ];
    if (!allowedCategories.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    // Check for existing submission from this email
    const { data: existingSubmissions, error: lookupError } = await supabase
      .from('project_submissions')
      .select('id')
      .eq('email', normalizedEmail)
      .eq('status', 'pending')
      .limit(1);

    if (lookupError) throw lookupError;

    if (existingSubmissions?.length > 0) {
      return res.status(400).json({
        error:
          'You already have a pending submission. Please wait for it to be reviewed before submitting again.'
      });
    }

    const uploadedImage = await uploadSubmissionImage(uploadedFile);
    const resolvedImageUrl = uploadedImage?.image_url || image_url || null;

    // Save submission to Supabase
    const approval_token = randomBytes(32).toString('hex');
    let submission;
    try {
      const { data, error: dbError } = await supabase
        .from('project_submissions')
        .insert({
          name,
          email: normalizedEmail,
          project_name,
          description,
          category,
          image_url: resolvedImageUrl,
          status: 'pending',
          approval_token
        })
        .select('id, name, email, project_name, description, category, image_url, status, approval_token')
        .single();

      if (dbError) throw dbError;
      submission = data;
    } catch (dbError) {
      if (uploadedImage?.storage_path) {
        await supabase.storage
          .from(STORAGE_BUCKET)
          .remove([uploadedImage.storage_path]);
      }

      throw dbError;
    }

    try {
      await Promise.all([
        email.sendApprovalRequestEmail({
          ...submission,
          link: link || null
        }),
        email.sendSubmissionConfirmationEmail(submission)
      ]);
    } catch (emailError) {
      await supabase.from('project_submissions').delete().eq('id', submission.id);

      if (uploadedImage?.storage_path) {
        await supabase.storage
          .from(STORAGE_BUCKET)
          .remove([uploadedImage.storage_path]);
      }

      throw emailError;
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Submit error:', error);
    return res.status(500).json({
      error: 'Something went wrong',
      details: error?.message || 'Unknown submit error'
    });
  }
};
