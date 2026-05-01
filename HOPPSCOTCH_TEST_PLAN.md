# Hoppscotch Test Plan

Use your deployed base URL:

- `https://the-space-middleware.vercel.app`

## 1. Submit a Project

- Method: `POST`
- URL: `https://the-space-middleware.vercel.app/api/projects/submit`
- Headers:
  - `Content-Type: application/json`
- Body:

```json
{
  "name": "Test User",
  "email": "test@example.com",
  "project_name": "Hoppscotch Demo",
  "description": "Testing submission flow",
  "category": "other",
  "image_url": "https://example.com/image.jpg",
  "link": "https://example.com"
}
```

Expected:

- `200 OK`
- A row is created in Supabase
- `status = pending`
- `approval_token` is populated
- Team review email is sent
- Confirmation email is sent to the submitter

If you want to test the image upload path specifically:

- Send the request as `multipart/form-data`
- Include a file field for the image
- The backend should upload it to Supabase Storage and save the public URL in `image_url`

Failure cases to test:

- Missing `name`, `email`, `project_name`, or `category` returns `400`
- Invalid `category` returns `400`
- Duplicate pending submission for the same email returns `400`

## 2. Approve via Link

- Method: `GET`
- URL:

```text
https://the-space-middleware.vercel.app/api/projects/approve?id=SUBMISSION_ID&token=APPROVAL_TOKEN
```

Expected:

- Response page shows approved
- Row status changes to `approved`
- `reviewed_at` is set
- Submitter gets the approval email

Failure cases to test:

- Wrong token returns `404` or invalid-token response
- Missing `id` returns `400`
- Reusing the same link shows that it has already been reviewed

## 3. Reject via Link

- Method: `GET`
- URL:

```text
https://the-space-middleware.vercel.app/api/projects/reject?id=SUBMISSION_ID&token=APPROVAL_TOKEN
```

Expected:

- Response page shows rejected
- Row status changes to `rejected`
- `reviewed_at` is set
- Submitter gets the rejection email

Failure cases to test:

- Wrong token returns `404` or invalid-token response
- Missing `id` returns `400`
- Reusing the same link shows that it has already been reviewed

## 4. Admin Approve

- Method: `POST`
- URL: `https://the-space-middleware.vercel.app/api/projects/approve`
- Headers:
  - `Content-Type: application/json`
  - `x-admin-secret: YOUR_ADMIN_SECRET`
- Body:

```json
{
  "id": "SUBMISSION_ID"
}
```

Expected:

- Approves without needing a token
- Status becomes `approved`
- Outcome email is sent

## 5. Admin Reject

- Method: `POST`
- URL: `https://the-space-middleware.vercel.app/api/projects/reject`
- Headers:
  - `Content-Type: application/json`
  - `x-admin-secret: YOUR_ADMIN_SECRET`
- Body:

```json
{
  "id": "SUBMISSION_ID"
}
```

Expected:

- Rejects without needing a token
- Status becomes `rejected`
- Outcome email is sent

## High-Value Checks

- Submit one row, approve it, then try rejecting it. It should say already reviewed.
- Submit a second row and reject that one.
- Use a bad `x-admin-secret` and confirm `401`.
- Break `RESEND_API_KEY` temporarily and confirm submit/review fail as intended.
- Confirm `MIDDLEWARE_URL` matches the deployed domain exactly, since the team email buttons depend on it.

## Database Checks

Make sure `project_submissions` has these columns:

- `approval_token`
- `status`
- `reviewed_at`
