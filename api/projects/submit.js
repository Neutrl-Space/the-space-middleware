// POST — receives form submission
import supabase from '../../lib/supabase';

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
    const { name, email, project_name, description, category, image_url } =
      req.body || {};

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

    // Save submission to Supabase
    const { error: dbError } = await supabase.from('project_submissions').insert({
      name,
      email,
      project_name,
      description,
      category,
      image_url: image_url || null,
      status: 'pending'
    });

    if (dbError) throw dbError;

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Submit error:', error);
    return res.status(500).json({
      error: 'Something went wrong',
      details: error?.message || 'Unknown submit error'
    });
  }
};
