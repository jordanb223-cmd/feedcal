# Decisions

Each entry: date, decision, why, and what would change it.

## D1 — Supabase for data, auth, storage, jobs (2026-11-20)
Postgres with RLS lets the database itself enforce who can see a feed. Auth, Storage, Queues (pgmq), pg_cron and Edge Functions come in one platform. Would change if Edge Function time limits block core processing (see D6).

## D2 — Cloudflare for domain, web and inbound email (2026-11-20)
Supabase can't receive email; Cloudflare Email Routing can hand mail to a Worker. Pages serves calendar files with custom headers and caching. GitHub Pages isn't used: Pages sites are public and GitHub limits commercial use (`UNVERIFIED` — check current GitHub Pages docs).

## D3 — GitHub for code, CI and deploys (2026-11-20)
Repo on GitHub (public since D19), Actions for checks and deploys, Dependabot, gitleaks (D20).

## D4 — Forwarding before the Gmail API (2026-11-20)
A forwarding address per feed needs no access to anyone's mailbox, so no Google restricted-scope review. The Gmail connection (Phase 17) needs `gmail.readonly`, a restricted scope (`UNVERIFIED` — confirm review steps and timing in Google's current docs before Phase 17).

## D5 — Buy Me a Coffee for donations (2026-11-20)
No card data on our servers. Webhooks are signature-checked (header and algorithm `UNVERIFIED` until Phase 15).

## D6 — Cloudflare Worker fallback for oversized PDFs (2026-11-20)
Large PDFs may exceed Edge Function time or memory limits. A Worker processor takes over only for those files.

## D7 — Hono on Cloudflare Pages advanced mode (2026-11-20)
The plan allowed Hono or SvelteKit. Hono is chosen: small, server-rendered HTML fits "no heavy SPA," and it runs unchanged in Pages, Workers and Vitest. The app is bundled by esbuild into `dist/_worker.js`; version and commit are injected at build time.

## D8 — npm workspaces (2026-11-20)
No extra tool to install. Packages export TypeScript source directly (`exports: ./src/index.ts`); the web build bundles them.

## D9 — Feed tokens stored as hash + Vault-encrypted copy (2026-11-20)
From BUILD-PLAN revision 1. Lookup uses SHA-256 of the token; the owner can view the link again from a Vault-encrypted copy. Implemented in Phase 2.

## D10 — Health probe via an anon-callable RPC (2026-11-20)
`public.health_check()` returns `true` and reads no tables, so exposing it to `anon` reveals nothing. The web app never holds the service-role key.

## D11 — Column-level grants on top of RLS (2026-11-20)
RLS decides which rows a role can see; it can't hide columns. Supabase's default table grants are revoked, and each role is granted only the columns it needs. Token columns are granted to nobody but the service role; the SECURITY DEFINER token functions read them. Anon reads public-safe columns of public feeds and their published events. Signed-in non-members read public pages through `public_feed_page()`, not the tables, so evidence quotes stay with the feed's members. Cost: app code must list columns instead of using `select *`.

## D12 — Policy helpers in a `private` schema (2026-11-20)
`private.is_feed_member()`, `private.feed_role()` and similar are SECURITY DEFINER with `search_path = ''`. They let policies on `feeds` and `feed_editors` check membership without recursing through each other's RLS. The schema isn't exposed by the API.

## D13 — Feed token minted by a trigger (2026-11-20)
Every feed gets a token on insert, in the same transaction as its Vault secret, so a failed insert leaves no orphan secret. Deleting a feed deletes its secret. Vault functions used: `vault.create_secret(new_secret, new_name, new_description, new_key_id)` and `vault.update_secret(secret_id, new_secret, ...)`, reading through `vault.decrypted_secrets`. These signatures were read from the local stack (`supabase_vault` 0.3.2). Hosted behaviour is `UNVERIFIED`; check it on the first staging deploy. Docs: https://supabase.com/docs/guides/database/vault

## D14 — public_feed_page returns upcoming events only (2026-11-20)
A subscribe page shows the next few events; returning a feed's whole history to anon is unnecessary exposure. It returns at most 200 events, with a default of 50. See the recurring-event gap in DATA-MODEL.md.

## D15 — Session checks ask the Auth server (`getUser`), not `getClaims` (2026-11-20)
Found while testing Phase 3. The local stack signs access tokens with ES256 (`kid` present). For those, `@supabase/supabase-js` 2.119.2 `getClaims()` checks only the signature against the public key and never asks the server. After "sign out everywhere", the old cookies still opened `/account`. The Auth server itself answered `403 session_not_found` for the same token. `currentUser()` now calls `getUser()`. That's one extra request per signed-in page, and revoked sessions stop working at once. Public pages and feed URLs don't check sessions, so they don't pay this cost.

## D16 — Magic links verified by our server, behind a button (2026-11-20)
The email template links to `/auth/confirm?token_hash=…&type=email`, which is Supabase's server-side "token hash" pattern. The GET only shows a "Sign in" button; the POST calls `verifyOtp`. Email security scanners that open links automatically therefore can't use up the one-time link. Because the error comes back to our server, it can say "expired or already used" in plain English. Docs: https://supabase.com/docs/guides/auth/server-side/email-based-auth-with-pkce-flow-for-ssr

## D17 — CSRF: double-submit cookie plus an origin check (2026-11-20)
Every POST must carry an `Origin` (or, failing that, `Referer`) equal to the site's own origin, and a form token equal to an HttpOnly cookie (`__Host-feedcal_csrf` over HTTPS). Either check failing returns 403 before any handler runs. The app has no JSON API yet; origin checks cover future API routes.

## D18 — Account deletion: SQL purge plus an Edge Function (2026-11-20)
`request_account_deletion()` stamps `profiles.deleted_at`. After 14 days, `due_account_deletions()` lists the account. `purge_account_data()` hands each owned feed to its longest-standing editor, deletes feeds with no editor (their Vault secrets go too), and wipes the name and revision actor. The `delete-accounts` Edge Function then deletes the auth user. The function only accepts the service-role key. **Scheduling it is not set up yet** (see SETUP.md).

## D19 — Public repository (2026-11-20)
GitHub's docs say that on GitHub Free, private repositories get no environments, no environment secrets, no branch protection and no rulesets. All of these work for public repositories. The deploy design (D3, CONTRIBUTING.md) needs them. The owner chose public over paying for GitHub Pro. Secrets stay in GitHub encrypted secrets, which aren't visible to the public. Before publishing, the commit history was rewritten so that commits carry GitHub's no-reply address and the plan carries no full name. The clean history went to a new repo, so the old commits aren't reachable by hash on a public repo. Docs: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments and https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

## D20 — Secret scan runs the gitleaks CLI over full history (2026-11-20)
`gitleaks-action@v2` scans only the pushed range (`<first>^..<last>`). That failed on the repo's first push, because the root commit has no parent. CI now downloads gitleaks 8.30.1, checks its SHA-256 against the release's checksums file, and scans the whole history on every run. That also covers rewritten or force-pushed history.

## D21 — Deploys need no database password; Pages settings come from the deploy script (2026-11-20)
- **No database password.** Supabase CLI 3.2.0 connects with the access token alone when `--remote` is used without `--password`. Its `db push --help` lists "Scoped access token … database_write" for that case. The CI secrets are therefore only `SUPABASE_ACCESS_TOKEN` and `CLOUDFLARE_API_TOKEN`. The old workflow also had two bugs this fixes: `db push` without `--remote` targets the *local* database in CLI 3.x, and `functions deploy` no longer takes `--project-ref`.
- **Pages settings per project.** Each Pages project deploys `main` as its production environment, so `wrangler.toml` `[env.production.vars]` would have labelled staging "production". `wrangler.toml` now has no vars. `.github/scripts/deploy.sh` sets `ENVIRONMENT`, `SUPABASE_URL` and `SUPABASE_ANON_KEY` on each Pages project, reading the public key with `supabase projects api-keys`. It also creates the Pages project if it's missing. Local values live in `apps/web/.dev.vars`.
- **Not yet checked:** the JSON field names from `supabase projects api-keys` (the script accepts both known shapes), and that `pages.dev` gives the projects their exact names. Both are confirmed by the first deploy.

## D22 — Calendar output: local times with generated VTIMEZONEs (2026-11-20)
- **Local times.** Timed events are written in their own zone (`DTSTART;TZID=America/Los_Angeles:…`) with a VTIMEZONE built from the runtime's IANA data (`Intl`). So a weekly 5:30pm practice stays at 5:30pm across daylight saving, which a UTC-only feed gets wrong.
- **How the VTIMEZONE is built.** Each offset change in the years the events touch is its own observance, with no RRULE. That is valid RFC 5545 and doesn't guess future rules. Recurring events get 5 years of coverage. Past that, calendar apps fall back to their own data for the IANA name.
- **Found in review:** the first version put the spring-forward change at 01:00 instead of 02:00. The tests missed it; reading the golden file caught it. Tests now pin exact change times for Los Angeles, Sydney and Adelaide, plus an event in the hour after a change.
- **Stable output.** `DTSTAMP` is the event's last change, not the request time. Identical data gives a byte-identical file and the same ETag, so `If-None-Match` gets a 304.
- **All-day events.** `starts_at` is any instant on the first day and `ends_at` any instant on the last day, both read in the event's zone. `DTEND` is the day after the last day (exclusive).
- **Validation.** Golden-file tests, plus ical.js (Mozilla's parser, MPL-2.0, test-only) parsing every file. Each timed event's start must read back as the original instant.
- **Gaps.**
  - The schema has no EXDATE column, so a single occurrence of a recurring event can't be skipped yet. Phase 10 needs this for updates.
  - Apple, Google and Outlook subscriptions are untested, because they need a hosted deploy.

## D23 — Subscribe page and links (2026-11-20)
- **The page carries the link.** `public_feed_page` returns the subscription token for public and unlisted feeds. A public feed's link is public by design (Rev 1); an unlisted page is reached only through its unguessable slug, so its link is exactly as secret as the page. Private feeds have no page.
- **Link formats are community-sourced; neither vendor documents them officially.**
  - Google: `https://calendar.google.com/calendar/r?cid=<url-encoded webcal URL>`. Seen in a Google Calendar Help Community thread and several developer write-ups.
  - Outlook: `https://outlook.live.com/calendar/0/addfromweb?url=…&name=…` (and `outlook.office.com` for Microsoft 365). Described as "never documented" by Microsoft (dev.to write-up).
  - The page always shows the plain link with a copy button, plus Android fallback steps.
  - Recheck all of these in the Phase 5 phone test (docs/TESTING.md).
- **Tap counting without JavaScript.** Buttons go through `/c/<slug>/go/<app>`, which counts the tap and then redirects. "Copy link" reports with a same-origin POST. The counts hold no personal data. Anyone can inflate them: that's accepted, and they're shown only as "taps", never as subscribers.
- **Count wording (Rev 4).** "At least N calendars follow this", with a line saying how it's counted (distinct calendar clients over 7 days; Google counts once for all its users).
- **Share kit.** `/feeds/<id>/share` replaces `/feeds/<id>/link` (which now gets a 301). Rotation redirects back to it after the POST, so refreshing can't rotate twice. QR codes are server-side SVG from `uqr` (MIT, no dependencies, works in Workers).
- **Found while testing:** the Phase 2 seed left `auth.users` token columns NULL, so seeded people couldn't sign in. Fixed; `005_seed_users_can_sign_in.test.sql` guards it.

## D24 — State machines live in the database; code and docs are generated from it (2026-11-20)
- **The survey** found eight implicit state machines (docs/STATE-MACHINES.md). Four were status columns that any value could jump to. Account deletion's "14 days" was written in five places.
- **Decision.** The database is the single source of truth.
  - `private.state_transitions` lists every legal move, and one trigger (`private.enforce_transition`) refuses any other move on UPDATE. Its error names the allowed moves.
  - `public.state_machines()` exposes the rules. `npm run db:states` generates `state-machines.generated.ts` and the diagrams, the same pattern as `db:types`, and CI fails if they're stale.
  - Hand-written labels are typed against the generated states, so a new state without a label won't compile.
- **Why the database, not TypeScript.** Phases 6–12 will change these columns from Edge Functions, SQL jobs and the web app. Only the database sees every writer.
- **Effect on users (UX):** clear status labels, and edits that actually reach subscribers' calendars (below). **On developers (DX):** one place to change a rule, generated types, errors that say what's allowed. **On AI agents (AX):** rules readable from one function and one doc; a wrong move fails loudly with the fix in the message, not silently.
- **Without breaking anything:** inserts aren't restricted, and every existing test passes unchanged (152 database tests).
- **Bug fixed along the way.** Nothing raised an event's `SEQUENCE` on edits, and calendar apps use it to decide whether an edit is newer. `private.events_bump_sequence` now raises it on any change a subscriber can see, unless the caller already raised it.
- **One grace period.** `private.deletion_grace()` defines it; `request_account_deletion`, `due_account_deletions` and the new `account_status()` read it; the account page shows what `account_status()` returns.
