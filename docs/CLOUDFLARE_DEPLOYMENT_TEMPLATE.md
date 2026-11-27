# Sanitized Cloudflare Pages + Worker + D1 Deployment Template

This template documents the optional serverless persistence architecture while omitting all institution-specific database UUIDs, secret tokens, and personal endpoints.

## 1. Architecture and Operational Boundaries

- **Client-Side Compute:** All CSP solving, 160-bit bitmask conflict checks, and optional TPE tuning run locally inside a browser Web Worker. Server-side solver compute cost is zero, while client execution latency scales with client hardware (desktop/Node.js v22 vs. mobile CPUs).
- **Edge Persistence (Cloudflare Workers + D1):**
  - Free-tier quotas apply (Workers Free: 100,000 requests/day, 10 ms CPU time per request; D1 Free: 5 GB storage, 5M row reads/day, 100k row writes/day).
  - Relying on Cloudflare Workers/D1 introduces vendor lock-in at the runtime/binding layer; the underlying SQL schema (`0001_init_schedules.sql`, `0002_add_version_occ.sql`) is standard SQLite and portable to self-hosted SQLite or PostgreSQL.

## 2. Production Hardening Controls

The reference implementation in the main application enforces three security and concurrency safeguards:

1. **Bearer Write Authentication:** `POST /api/schedules`, `PATCH /api/schedules/:id/activate`, and `DELETE /api/schedules/:id` verify `Authorization: Bearer <token>` in constant time against the `API_WRITE_TOKEN` Worker secret (`401 Unauthorized` on mismatch).
2. **Strict CORS Allowlist:** `ALLOWED_ORIGINS` is pinned to the explicit deployment origin (e.g., `https://your-domain.pages.dev`), never `*`.
3. **Optimistic Concurrency Control (OCC):** `0002_add_version_occ.sql` adds `version INTEGER NOT NULL DEFAULT 1` to `saved_schedules`. Mutations validate `expectedVersion` (`WHERE id = ? AND version = ?`) and return `409 Conflict` when concurrent chairs submit stale updates.

## 3. Setup Checklist

1. Copy `wrangler.example.jsonc` to `wrangler.jsonc` and populate `<YOUR_D1_DATABASE_ID>` and `<YOUR_PAGES_ORIGIN>`.
2. Apply migrations:
   ```bash
   npx wrangler d1 migrations apply timetable-db --remote
   ```
3. Provision write authentication secret:
   ```bash
   npx wrangler secret put API_WRITE_TOKEN
   ```
4. Deploy Worker and static Pages bundle.
