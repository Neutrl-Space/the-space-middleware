// GET  — returns all projects
import supabase from '../../lib/supabase';

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      status,
      category,
      date_from,
      date_to,
      order_by = 'submitted_at',
      order_dir = 'desc',
      limit = 50,
      page = 1
    } = req.query;
    const pageSize = Math.min(Number.parseInt(limit, 10) || 50, 100); // cap at 100
    const pageNumber = Number.parseInt(page, 10) || 1;

    // Determine if this is an admin or public request
    const isAdmin = req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;

    // Public requests can only ever see approved projects.
    // If a non-admin asks for another status, fail loudly instead of silently rewriting it.
    if (!isAdmin && status && status !== 'approved') {
      return res.status(403).json({
        error: 'Admin access required to view non-approved submissions'
      });
    }

    // Admin requests can filter by any status
    const resolvedStatus = isAdmin ? status : 'approved';

    const selectFields = isAdmin
      ? 'id, name, email, project_name, description, address, category, image_url, status, submitted_at, reviewed_at'
      : 'id, name, project_name, description, address, category, image_url, status, submitted_at, reviewed_at';

    let query = supabase
      .from('project_submissions')
      .select(selectFields, { count: 'exact' });

    // Apply status filter
    if (resolvedStatus) {
      query = query.eq('status', resolvedStatus);
    }

    // Apply category filter
    if (category) {
      query = query.eq('category', category);
    }

    // Apply date range filters
    if (date_from) {
      query = query.gte('submitted_at', new Date(date_from).toISOString());
    }
    if (date_to) {
      query = query.lte('submitted_at', new Date(date_to).toISOString());
    }

    // Apply ordering
    const ascending = order_dir === 'asc';
    query = query.order(order_by, { ascending });

    // Apply pagination
    const offset = (pageNumber - 1) * pageSize;
    query = query.range(offset, offset + pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    return res.status(200).json({
      projects: data,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        total: count
      }
    });
  } catch (error) {
    console.error('Projects fetch error:', error);
    return res.status(500).json({
      error: 'Something went wrong',
      details: error?.message || 'Unknown projects fetch error'
    });
  }
};
