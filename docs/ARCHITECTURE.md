# Architecture

Status: Phase 1 (foundation). Components marked *planned* don't exist yet.

## Components

```
 Organizer's mail ──► Cloudflare Email Routing ──► Email Worker (apps/email-worker)
                                                        │ HMAC-signed calls (Phase 6)
                                                        ▼
                         Supabase Edge Functions: ingest-start / ingest-commit   (planned)
                                                        │
                                        Storage (inbound-raw, private) + pgmq queue
                                                        ▼
                     Queue consumer: parse → triage → extract → reconcile         (planned)
                                                        │
                                                        ▼
                                Supabase Postgres (RLS on every table)
                                                        ▲
 Browser / calendar app ──► Cloudflare Pages (apps/web, Hono) ──┘ anon key + user session
```

| Component | Where | Phase | Holds which secrets |
|---|---|---|---|
| Web + feed server | `apps/web` → Cloudflare Pages (`_worker.js`) | 1 (health), 4–5, 11, 13 | Supabase anon key only |
| Email intake | `apps/email-worker` → Cloudflare Email Worker | 1 (stub, rejects all), 6 | Ingest HMAC secret only (Phase 6) |
| Queues and jobs | `supabase/functions` + pgmq + pg_cron | 6–12 | Service-role key (server side only) |
| Calendar generator | `packages/ics` | 4 | none |
| AI extraction | `packages/extract` | 9 | Claude API key (in Edge Function env) |
| Shared schemas/types | `packages/shared` | 1+ | none |
| Directory | Postgres functions + `apps/web` pages | 13 | none |

## Request flow today (Phase 1)

`GET /health` → request-id middleware → `public.health_check()` RPC with the anon key → JSON with version, commit, environment, database reachability. 200 when the database answers, 503 when it doesn't.

## Environments

| | Supabase | Web | Email Worker |
|---|---|---|---|
| local | `supabase start` (Docker) | `wrangler pages dev` on :8788 | `wrangler dev` |
| staging | separate project | Pages project `feedcal-web-staging` | `feedcal-email-worker-staging` |
| production | separate project | Pages project `feedcal-web` | `feedcal-email-worker-production` |

Each environment has its own secrets. See `docs/SETUP.md`.

## Logging

One JSON line per entry, via `createLogger` in `packages/shared`. Every web request logs method, path, status, duration and `request_id`. The incoming `x-request-id` is reused when it is 8–64 characters of `[A-Za-z0-9-]`; otherwise a UUID is generated. Email addresses, bodies and personal data are never logged.
