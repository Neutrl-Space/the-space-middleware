-- Run individual queries in Supabase SQL Editor (server/admin access only).
-- Totals and repeat visitors.
select count(*) as submissions, count(distinct contact_id) as unique_contacts
from public.becoming_access_submissions;
select c.email, count(*) as submissions
from public.becoming_access_submissions s join public.becoming_access_contacts c on c.id = s.contact_id
group by c.id having count(*) > 1 order by submissions desc;

-- Count each product once per submission even when multiple sizes were selected.
select product_id, product_title, count(distinct submission_id) as interested_submissions
from public.becoming_access_interests group by product_id, product_title order by interested_submissions desc;
select product_title, selected_size, variant_title, count(*) as selections
from public.becoming_access_interests group by product_title, selected_size, variant_title order by selections desc;

select utm_content, count(*) as submissions from public.becoming_access_submissions group by utm_content order by submissions desc;
select email, name from public.becoming_access_contacts where marketing_consent = true;
select id, created_at, shopify_sync_status, shopify_sync_error
from public.becoming_access_submissions where shopify_sync_status <> 'synced' order by created_at;

-- Replace the ID to report contacts interested in a specific product or variant.
select distinct c.email, c.name, c.phone, i.product_title, i.variant_title, i.selected_size
from public.becoming_access_contacts c
join public.becoming_access_submissions s on s.contact_id = c.id
join public.becoming_access_interests i on i.submission_id = s.id
where i.product_id = 'gid://shopify/Product/REPLACE_ID';
