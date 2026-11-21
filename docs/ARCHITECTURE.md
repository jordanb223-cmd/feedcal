# Architecture

Status: Phase 12 (notifications and motivation). Real email needs a provider key and a domain; locally it goes to Mailpit. Hosted email waits on a domain; AI calls wait on an Anthropic API key. Components marked *planned* don't exist yet. Schema and access rules: `docs/DATA-MODEL.md`.

## Components

```
 Organizer's mail ──► Cloudflare Email Routing ──► Email Worker (apps/email-worker)
                                                        │ HMAC-signed calls (Phase 6, D26)
                                                        ▼
                         Supabase Edge Functions: ingest-start / ingest-commit
                                                        │
                       Storage (inbound-raw, private) + pgmq queue "process_message"
                                                        ▼
   process-messages (7) → triage-attachments (8) → extract-events (9) → reconcile_pending() SQL (10), every minute
                                                        │
                                                        ▼
                                Supabase Postgres (RLS on every table)
                                                        ▲
 Browser / calendar app ──► Cloudflare Pages (apps/web, Hono) ──┘ anon key + user session
```

| Component | Where | Phase | Holds which secrets |
|---|---|---|---|
| Web + feed server | `apps/web` → Cloudflare Pages (`_worker.js`) | 1 (health), 4–5, 11, 13 | Supabase anon key only |
| Email intake | `apps/email-worker` → Cloudflare Email Worker (not deployed: needs the domain) | 6 | Ingest HMAC secret only |
| Queues and jobs | `supabase/functions` + pgmq + pg_cron | 6–12 | Service-role key (server side only) |
| Calendar generator | `packages/ics` | 4 | none |
| AI extraction | `packages/extract` | 9 | Claude API key (in Edge Function env) |
| Shared schemas/types | `packages/shared` | 1+ | none |
| Directory | Postgres functions + `apps/web` pages | 13 | none |

## Request flow today (Phase 1)

`GET /health` → request-id middleware → `public.health_check()` RPC with the anon key → JSON with version, commit, environment, database reachability. 200 when the database answers, 503 when it doesn't.

## Sign-in flow (Phase 3)

- **Magic link:** `POST /login` → Supabase emails a link to `/auth/confirm?token_hash=…` → that page shows a button → `POST /auth/confirm` calls `verifyOtp` → session cookies (HttpOnly, SameSite=Lax, Secure over HTTPS) → `/account`.
- **Google:** `POST /auth/google` → Supabase → Google → `/auth/callback?code=…` → `exchangeCodeForSession` → the `next` path, which must be on this site.
- **Every POST** passes the origin check and the CSRF check first (D17).
- **Signed-in pages** check the session with the Auth server on every request (D15).
- **Account deletion:** `/account` → `request_account_deletion()`. After 14 days, the `delete-accounts` Edge Function purges the account (D18).

## Feed flow (Phase 4)

`GET /f/<token>.ics`:
1. Check the token's format.
2. Call `feed_calendar()` with the anon key.
3. Validate the result with Zod (`FeedCalendarData`).
4. Build the file with `@feedcal/ics`.
5. Send it with an ETag, `Cache-Control: max-age=900` and no CORS headers; private and unlisted feeds also get `X-Robots-Tag: noindex`.

The request log records the path as `/f/[token]`. Owners and editors see the link at `/feeds/<id>/link`, and the owner can rotate it there.

## Subscribe and share (Phase 5)

`/c/<slug>` is the public subscribe page: `public_feed_page()` validated with Zod, a device-aware button, link-preview tags, and `noindex` for unlisted feeds. `/c/<slug>/go/<app>` counts a tap and redirects to the calendar app. `/feeds/<id>/share` is the owner's kit: page link, calendar link, QR code, group-chat text, stats, link rotation. `/feeds/<id>/flyer` is the printable flyer.

## Environments

| | Supabase | Web | Email Worker |
|---|---|---|---|
| local | `supabase start` (Docker) | `wrangler pages dev` on :8788 | `wrangler dev` |
| staging | separate project | Pages project `feedcal-web-staging` | `feedcal-email-worker-staging` |
| production | separate project | Pages project `feedcal-web` | `feedcal-email-worker-production` |

Each environment has its own secrets. See `docs/SETUP.md`.

## Logging

One JSON line per entry, via `createLogger` in `packages/shared`. Every web request logs method, path, status, duration and `request_id`. The incoming `x-request-id` is reused when it is 8–64 characters of `[A-Za-z0-9-]`; otherwise a UUID is generated. Email addresses, bodies and personal data are never logged.
