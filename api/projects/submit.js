// POST — receives form submission
import { storage as _storage, from } from '../../lib/supabase';
import { triggerKlaviyoEvent } from '../../lib/klaviyo';
import multer, { memoryStorage } from 'multer';

// Store file in memory instead of disk
const upload = multer({ storage: memoryStorage() });

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
    const { name, email, project_name, description, category } = req.body;

    // Validate required fields
    if (!name || !email || !project_name || !category) {
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

    let image_url = null;

    // Handle image upload if one was provided
    if (req.file) {
      const fileName = `${Date.now()}-${req.file.originalname}`;

      const { data, error } = await _storage
        .from('project-images')
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype
        });

      if (error) throw error;

      // Get the public URL
      const { data: urlData } = _storage
        .from('project-images')
        .getPublicUrl(data.path);

      image_url = urlData.publicUrl;
    }

    // Save submission to Supabase
    const { error: dbError } = await from('project_submissions').insert({
      name,
      email,
      project_name,
      description,
      category,
      image_url,
      status: 'pending'
    });

    if (dbError) throw dbError;

    // Trigger Klaviyo emails
    await triggerKlaviyoEvent('Project Submitted', email, {
      project_name,
      category
    });

    // Internal alert to The Space team
    await triggerKlaviyoEvent(
      'New Submission Alert',
      'team@thespace.com', // replace with the client's team email
      { project_name, submitted_by: name, category }
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Submit error:', error);
    return res.status(500).json({ error: 'Something went wrong' });
  }
};
