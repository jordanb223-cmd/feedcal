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

## D25 — Quick wins before Phase 6 (2026-11-21)
- **Error pages.** A request that accepts `text/html` gets an HTML 404/500 page: what happened, what to try, and the request id. `/health`, `/f/*` and `/.well-known/*` always answer as machines. Error details never reach the page; they're logged by name only.
- **The login form keeps the typed address** on every failure (escaped). The other forms have no typed fields (checkboxes and buttons only), so they had nothing to keep.
- **International addresses (RFC 6531) are refused, with a clear message.** Tested against the local Auth server (GoTrue v2.198.0) on 2026-11-21: `pelé@example.test` and `user@bücher.example` both return `validation_failed: invalid format`. Hosted Auth was not tested (UNVERIFIED that it matches; it runs the same open-source server). Revisit if GoTrue adds support.
- **Session timeouts are not available on the free plan.** supabase.com/pricing lists "Session timeouts: Not included in free" (checked 2026-11-21); docs: supabase.com/docs/guides/auth/sessions. No idle or absolute limit is set. Sessions end on sign-out, "sign out everywhere", or refresh-token expiry. Set 30 days absolute / 7 days idle if the projects move to Pro.
- **Our own sign-in email limit:** 5 per address and 20 per IP per rolling hour (`public.login_attempt_allowed`, limits in `private.login_limits()`). Stored as salted sha256 hashes, pruned every call. Refused attempts aren't counted. If the check fails, sign-in fails closed with a "try again in a minute" message. Known limit: anyone can use up an address's 5 attempts for an hour, by the form or by the RPC; that's the cost of any per-address limit.
- **Stranger test against the real stack.** `tests/integration/stranger.test.ts` signs Alice and Bob in with real sessions and proves Bob gets 404 on Alice's share kit and flyer and can't rotate her link, which keeps working. CI runs it in the database job.
- **Vulnerability reports** go through GitHub private vulnerability reporting (turned on 2026-11-21), so no email address is published. `/.well-known/security.txt` points at it; a test fails 30 days before its `Expires` date.
- **CHANGELOG.md** is written for organizers. The production deploy fails if the tag has no `## [X.Y.Z]` section.
- **Runbook:** docs/runbooks/stolen-laptop.md.

## D26 — Email intake by forwarding (2026-11-21)
- **Flow.** Cloudflare Email Routing (catch-all on `in.<domain>`) → Email Worker → `ingest-start` (HMAC) → one-time signed upload to the private `inbound-raw` bucket → `ingest-commit` (HMAC) → SQL `ingest_commit` → pgmq `process_message`. The Worker holds only `INGEST_HMAC_SECRET` and the public Supabase URL. It reads nothing but the size and the address.
- **Signing.** HMAC-SHA256 over `timestamp.body`, refused if more than 5 minutes off. One pinned test vector, checked with `openssl`, is asserted on both sides.
- **Addresses.** `feed-` + 20 base32 characters (100 random bits, no modulo bias since 256 = 8 × 32). Owners can rotate them. Members only can read them.
- **Headers are read in `ingest-commit`, never in the Worker.** Message-ID, From, Subject (RFC 2047 decoded), the first `Authentication-Results`, an approximate attachment count (`Content-Disposition: attachment` lines), and sha256 of the body below the headers. Full MIME parsing is Phase 7.
- **Authentication results.** Cloudflare's Workers docs say Email Routing checks DMARC and prepends one `Authentication-Results` header with authserv-id `mx.cloudflare.net`; only that first header is trusted (developers.cloudflare.com/email-service/api/route-emails/email-handler/, checked 2026-11-21). DMARC `fail` → quarantine even for a trusted sender. A missing header records nothing and doesn't quarantine on its own.
  - Risk: a Cloudflare community thread (Oct 2025) reports Email Routing dropping Gmail-forwarded mail on DMARC alignment. UNVERIFIED for our case; step 6 of the Phase 6 hand test checks it.
- **Allowlist.** The first mail from a sender creates an untrusted `sources` row and waits (`quarantine_reason = new_sender`). "Yes" trusts the sender and queues its waiting mail; "No" blocks it, ignores its waiting mail, and drops later mail quietly (no bounce).
- **Gmail confirmation.** Sender `forwarding-noreply@google.com` and subject `(#<digits>) Gmail Forwarding Confirmation - Receive Mail from <address>`. Both come from Gmail Help Community threads and forum posts; Google's own help pages don't spell them out (UNVERIFIED until the hand test). Captured only if DMARC passed, and the link is kept only if it's on `mail-settings.google.com` or `mail.google.com`. Shown on the page, never clicked by us.
- **Limits** (`private.intake_limits()`): 20 MB, 10 attachments, 50 accepted emails per feed per 24 hours. Over-limit mail is bounced with a plain reason. Duplicates and blocked senders are accepted silently.
- **Dedupe** on Message-ID or body sha256, per feed; idempotent commit (a ticket returns its first result).
- **Failures on our side throw instead of bouncing,** so the sending server can retry. That Cloudflare turns a thrown error into a temporary SMTP failure is UNVERIFIED; check it in the hand test.
- **Expiry.** Messages expire after 30 days. SQL can't delete stored files (`storage.protect_delete` refuses it), so deleting a message queues its file in `private.storage_trash`. pg_cron runs `private.expire_intake()` daily at 03:17 UTC, then calls the `storage-trash` Edge Function through pg_net, which deletes the files through the Storage API. The deploy script writes the function URL and the public anon key into `private.app_settings`, using the Management API's "Run sql query" endpoint (documented as experimental). `storage-trash` only deletes files already queued, so a stranger calling it changes nothing.
- **Owner screen** `/feeds/<id>/email`: the address, the Gmail confirmation, waiting senders, suspicious mail, setup guides, and a new-address button.
- **Not done here, by design:** nothing consumes `process_message` yet (Phase 7). The Worker isn't deployed and Email Routing isn't set up, because both need the domain (SETUP §7).

## D27 — Phase 6 facts checked after the build (2026-11-21)
What was checked, against what, and what changed:
- **Gmail forwarding** (support.google.com/mail/answer/10957): Gmail confirms a new forwarding address with a **verification link**; its steps don't mention typing a code. The filter option is **Forward it**. Google says that to forward only some mail you leave automatic forwarding off and use a filter. Changed: the page makes the Google link the main action, with the code secondary, and the guide matches Google's wording. Still unverified: the sender address and subject format of the confirmation email (community sources only; Google's page doesn't give them).
- **Outlook** (support.microsoft.com, "Use rules to automatically forward messages"): Settings → Mail → Rules → **Add rule**; the actions are Forward to, Forward as attachment, and Redirect to. Microsoft says forwarded messages "will appear to be forwarded from you". Changed: the guide says the organizer will be asked once to approve their own address.
- **Apple** (support.apple.com Mail for Mac "Change Rules settings"; iCloud "Set up rules to filter email in Mail on iCloud.com"): Mail → Settings → Rules → Add Rule on a Mac is confirmed. iCloud.com has server-side rules. Changed: an iCloud Mail section is added. Still unverified: the exact name of the iCloud forward action (the page implies forwarding but the excerpt doesn't name it).
- **Cloudflare** (developers.cloudflare.com/email-service/api/route-emails/email-handler/): `setReject` sends a **permanent** SMTP error, and the Authentication-Results guidance matches D26. The page also gives a 25 MiB inbound size (ours is 20 MB, so lower). Still unverified: what a thrown error does. The docs' own example catches errors instead of throwing. Left as is until the hand test shows the behaviour.
- **Management API** "Run sql query" (`POST /v1/projects/{ref}/database/query`) is documented and marked experimental. Not yet run against a hosted project.
- **QR codes** (open since Phase 5): decoded in Chromium's BarcodeDetector from the live share kit and flyer SVGs. Both decode to exactly the page link.
- **Not checkable without the domain and secrets:** the real Gmail forward, DMARC on Gmail-forwarded mail at Cloudflare, hosted Auth's handling of international addresses, link previews, and the three-person phone test.

## D28 — Parsing forwarded email (Phase 7, 2026-11-21)
- **Consumer.** The `process-messages` Edge Function claims up to 5 jobs at a time from pgmq `process_message` (180-second visibility, so a crash is retried), parses each, uploads kept attachments to the private `attachments` bucket, and calls `record_parsed_message`. pg_cron calls it every minute through `private.call_edge_function`. Five failures mark the message `failed`. Like `storage-trash`, it only acts on queued jobs, so the public key is enough to call it.
- **Libraries,** pinned to releases more than two weeks old: postal-mime 4.2.0 (MIT-0; Cloudflare's Workers docs recommend it for MIME) and linkedom 0.18.14 (ISC; a DOM for HTML conversion). They're root devDependencies only so Deno can resolve `npm:` imports in this repo; the web app doesn't ship them.
- **Body choice.** Prefer `text/plain`, unless it's a "view in browser" stub or under 20% of the HTML's text; then convert the HTML.
- **HTML → text.** Data tables become `cell | cell` rows; layout tables (cells containing blocks) read as paragraphs. Links become `text (url)`, mailto links the address. Dropped: images, tracking pixels, scripts, styles, and hidden elements (`display:none`, `visibility:hidden`, `mso-hide:all`, `hidden`).
- **Forwards.** Gmail ("Forwarded message"), Apple Mail ("Begin forwarded message:") and Outlook (the `____` rule, or a bare From/Sent/Subject block) are unwrapped to the innermost original, up to 5 deep. Outlook writes the same block for replies, so it counts as a forward only under an `FW:`/`Fwd:` subject. "Forward as attachment" (a `message/rfc822` part) is parsed as the original. The original's sender, subject and sent date win; forwarders' notes are kept apart in `parse_details`.
- **Reference date** = the original's sent date. A forward header without a zone (Gmail's "Mon, Nov 17, 2026 at 9:14 AM") is read in the outer message's Date-header offset: an approximation, since the forwarder's zone usually matches. Fallbacks: the Date header, then the received time.
- **Quotes and signatures.** Cut at "On … wrote:", Outlook reply blocks, "Original Message", and `>` lines; signatures after `-- ` near the end; "Sent from my iPhone"-style lines. All of it goes to `stripped_text`. The spec said to keep it in Storage; a column with the same 30-day expiry does the same job with one less moving part.
- **Images.** Dropped when under 20 KB, under 300 px on the short side (read from PNG/GIF/JPEG/WebP headers), or named like logos, icons, social links or spacers. TNEF (`winmail.dat`), vCards and signature files are dropped too. Everything dropped is listed in `parse_details.discarded`, so an owner can see what was set aside. Identical files are stored once.
- **Language** is a small script-and-stopword guess (en, es, fr, de, pt, it, nl, and he, ar, ru, el, zh, ja, ko by script), or `und`.
- **Fixtures.** 26 invented emails, generated by `fixtures/build.ts`: newsletter, sports table, appointment, venue list, flyer image only, PDF only, Gmail/Outlook/Apple forwards, a two-level chain, a reply with a changed time, forward-as-attachment, quoted-printable, Latin-1 French, Spanish, Hebrew, an .ics invite, an inline poster, tracking/hidden content, a mobile signature, an Outlook reply that isn't a forward, duplicate attachments, winmail/vCard, base64 text, layout tables, and Outlook's numeric date. Expectations were written from each email's meaning before the first run. The first run caught a real bug (the "view in browser" pattern missed "View this email in your browser").
- **Limits of this phase.** The fixtures are built from documented formats and real-world shapes, not captured from real clients, so a real Gmail or Outlook forward may differ (the Phase 6 hand test will show it). Nothing reads `parsed` messages yet (Phases 8–9).

## D29 — Attachment triage, cheapest step first (Phase 8, 2026-11-21)
- **Flow.** `record_parsed_message` queues `triage_message`. `triage-attachments` (pg_cron every minute) reads each email's attachments in stages and records kept pages in `attachment_pages`, then queues `extract_message` for Phase 9.
- **Stage 0, the owner's rule** (`sources.attachment_rule`): `prefer` entries (filename pattern + type + pages) win outright, and the email's other files are skipped as `rule_other`. `never` entries skip. Patterns come from the picked file's name, lower-cased and regex-escaped with digit runs generalised, so `Schedule-Week-47.pdf` learns `^schedule-week-\d+\.pdf$`. The spec also mentioned a layout hash; it's left out because filename + page + type covered every test case and needs no page rendering. Revisit if real senders reuse one filename for different layouts.
- **Stage 1, metadata, no file reads.** Unsupported types (Word, Excel and the like for now), over 15 MB, receipt- or invoice-like names, and files already read in an earlier email to the same feed (same sha256) are skipped. "Read big files from this sender" lifts the 15 MB / 40-page limit.
- **Stage 2, text.** unpdf 2.1.0 (MIT) reads each PDF page's text layer. Pages are scored on months, weekdays, dates, times and event words, by density so long prose doesn't win on volume. Pages scoring 3 or more are kept, best first, **5 pages per email across all its files**: preferred pages, then .ics files, then score. `text/plain`, `text/csv` and `text/calendar` attachments are one page each.
- **Stage 4, vision last.** Photos, and PDFs with almost no text layer (under 40 characters a page), go to a vision model. Scans send only the owner's preferred page or their first 2 pages. Each PDF page is sent as a one-page PDF (pdf-lib 1.17.1, MIT) in a `document` block, so nothing has to be rendered. The model, `claude-opus-5-5` at effort `low`, is asked for a word-for-word transcription that treats instructions on the page as text; refusals fall back server-side (`fallbacks: "default"`) and are recorded as `vision_refused`. Anthropic's vision docs (checked 2026-11-21): images up to 8000×8000 px and 10 MB base64; current models downscale to a 2,576 px long edge, at most 4,784 tokens per image (⌈w/28⌉×⌈h/28⌉). That caps cost without our own resizing, which would need an image library in the Edge runtime; this replaces the spec's "1600 px". Images over 7 MB are skipped.
- **Vision is off unless `ANTHROPIC_API_KEY` is set** (in Supabase secrets). It costs money and the project is on free tiers, so photos and scans wait as `pending` with reason `needs_vision_not_configured` and the page says so. The SDK is `@anthropic-ai/sdk` 1.6.0, the newest release more than two weeks old. Tests use a fake transcriber, so **no real transcription has been run** (UNVERIFIED end to end).
- **Caps** per feed owner per day (`private.triage_limits()`): 300 text pages, 20 vision pages. Over the cap, files wait. Each attachment logs its stage, reason, kept pages and, for vision, tokens and an estimated cost at $4 / $20 per million input/output tokens.
- **Owner feedback** on the email page ("Recent emails"): "This one has the schedule" sets `chosen`, learns `prefer`, removes the same pattern from `never`, and re-reads the email. "Never use files like this" learns `never`, skips the file now, and removes its pages. Photo thumbnails use 10-minute signed URLs under a members-only storage policy; PDFs show their name and pages, with no thumbnail.
- **State machine.** New moves: `text_layer`/`transcribed` → `skipped` (the owner rules a file out) and → `pending` (re-read). `record_triage` goes through `pending` when a direct move isn't legal (for example `failed` → `text_layer`).
- **Passes-when status.** 40-page newsletter: at most 5 pages sent (Deno test: exactly its 2 schedule pages). Next email after "this one": goes straight to the matching file (Deno test, and end to end with a real signed-in owner). Flyer photo read correctly: **only with a fake transcriber**; needs an API key to check for real.
