# Azhagapparacademy-Backend

## Cloudinary (videos + images)

This backend uploads media (QR codes, thumbnails, payment proofs, and **level videos**) to Cloudinary when configured.

### Required environment variables (recommended)

Set **one** of the following options in your hosting provider (Render, etc.):

**Option A (single var):**

- `CLOUDINARY_URL=cloudinary://<API_KEY>:<API_SECRET>@<CLOUD_NAME>`

**Option B (3 vars):**

- `CLOUDINARY_CLOUD_NAME=<CLOUD_NAME>`
- `CLOUDINARY_API_KEY=<API_KEY>`
- `CLOUDINARY_API_SECRET=<API_SECRET>`

### Optional

- `CLOUDINARY_UPLOAD_ROOT=video-learning-platform` (default)
- `REQUIRE_CLOUD_STORAGE=true` (default) — set to `false` only if you want to allow local uploads in production.

### Notes

- Videos are uploaded with `resource_type=video` and streamed through the authenticated `GET /api/levels/:id/stream` endpoint.