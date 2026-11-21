# Owner setup (things only you can do)

Steps only the owner can do. Done items are checked.

## 1. Local database — done 2026-11-20
- [x] Container runtime: **Colima** (free, open-source) instead of Docker Desktop, installed with `brew install colima docker gitleaks`. Its VM has 4 CPUs, 8 GB memory and a 60 GB disk.
- [x] `npm run db:start`, `npm run db:reset`, `npm run db:test` pass (3 pgTAP tests).
- [x] `packages/shared/src/database.types.ts` regenerated from the real schema.
- [x] `apps/web/.dev.vars` holds the local anon key (git-ignored). `/health` returns `"status":"ok"`.

**After a reboot**, Colima doesn't start on its own. Run:
```bash
colima start
```
Then `npm run db:start` in the repo. To have Colima start at login instead, run `brew services start colima`. That adds a login item, so it's your choice.

## 2. GitHub — done 2026-11-20
- [x] Public repo `jordanb223-cmd/feedcal` (D19 explains why public). Commits use GitHub's no-reply address, not a personal email: this checkout has `git config user.email 242484726+jordanb223-cmd@users.noreply.github.com`.
- [x] Branch protection on `main` and the `staging` / `production` environments, as in `docs/CONTRIBUTING.md`.
- [x] Secret scanning and push protection turned on (free for public repos).
- [ ] The old private repo was renamed `feedcal-old-private`. It still holds the pre-cleanup history (your personal email on the commits). Delete it when you're ready: GitHub → that repo → Settings → Delete this repository.

## 3. Supabase — done 2026-11-20 (free plan)
- [x] `feedcal-staging`: ref `rqfpfgogylcjvuqrhgeb`, East US (Ohio).
- [x] `feedcal-production`: ref `psqytjoxeejxgnaqrisn`, East US.
- [x] Supabase generated each database password. Nobody copied them, because deploys don't use them (D21). To get into a database directly, reset its password under Project Settings → Database.
- [x] Free projects pause after 7 days of low activity, and the free plan allows two active projects (Supabase billing FAQ). Your paused "CA VOTE" and "Shortcut" projects don't count.

## 4. Cloudflare — done 2026-11-20
- [x] Account id `f8b8dbea6dc1bfb6de8ed355428ead36`, stored as the GitHub variable `CLOUDFLARE_ACCOUNT_ID`.
- [x] Pages projects `feedcal-web-staging` and `feedcal-web` are created by the first deploy (`.github/scripts/deploy.sh`). Their addresses will be `https://feedcal-web-staging.pages.dev` and `https://feedcal-web.pages.dev`. Those names were free when checked; if Cloudflare adds a suffix, update `STAGING_URL` / `PRODUCTION_URL`.
- [x] Each Pages project's `ENVIRONMENT`, `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set by the deploy script (D21). Nothing to do by hand.
- [ ] Later, with a domain: add it, then Email Routing (Phase 6).

## 5. GitHub secrets — TO DO: 2 pastes, works from a phone
The values that aren't secret are already set: `CLOUDFLARE_ACCOUNT_ID` for the repo; `SUPABASE_PROJECT_REF` and `STAGING_URL` / `PRODUCTION_URL` per environment.

**1. Supabase access token**
- Open https://supabase.com/dashboard/account/tokens → **Generate new token**. Name it `feedcal-github-actions`. Copy it.
- Open https://github.com/jordanb223-cmd/feedcal/settings/secrets/actions/new
  - Name: `SUPABASE_ACCESS_TOKEN`
  - Secret: paste the token.
  - Tap **Add secret**.

**2. Cloudflare API token**
- Open https://dash.cloudflare.com/profile/api-tokens → **Create Token** → **Create Custom Token** (`UNVERIFIED`: button wording).
  - Name: `feedcal-github-actions`
  - Permissions: **Account → Cloudflare Pages → Edit**
  - Account resources: your account.
  - Continue → Create. Copy the token.
- Open https://github.com/jordanb223-cmd/feedcal/settings/secrets/actions/new
  - Name: `CLOUDFLARE_API_TOKEN`
  - Secret: paste the token.
  - Tap **Add secret**.

**Then** tell Claude "secrets are in". It reruns the staging deploy and checks `https://feedcal-web-staging.pages.dev/health`.

These are repository secrets, used by both environments. Production deploys still wait for your approval in the `production` environment.

## 6. Sign-in (Phase 3), hosted projects
Local sign-in needs none of this: Mailpit at http://127.0.0.1:54324 catches the emails.

**Done 2026-11-20, on both projects:**
- [x] Site URL set to the project's `pages.dev` address.
- [x] Redirect URLs: only that address + `/auth/callback`.
- [x] Email link expiry: 900 seconds (15 minutes).

**Waiting on a domain (costs money, so not yet):**
- [ ] **Custom email (Resend or Postmark).** Verify the domain and add its **SPF**, **DKIM** and **DMARC** records in Cloudflare DNS. Then enter the SMTP details in Supabase → Authentication → Emails → SMTP Settings. The key goes only there, never in the repo.
- [ ] **Branded template.** Supabase only lets you edit email templates once custom SMTP is set. Then paste `supabase/templates/magic_link.html` into **Magic link or OTP** and **Confirm sign up**, with the subject "Your Feedcal sign-in link".
- [ ] **Until then,** hosted projects send Supabase's default email. Its link goes through Supabase to `/auth/callback`, so sign-in works. Staging lacks two things until then: the "Continue" button that guards against link scanners, and the specific "expired or already used" message. Expired links get a general "try again". Supabase's built-in sender is for testing only and may only deliver to your own team's addresses (`UNVERIFIED`).

**Google sign-in.**
- [ ] Google Cloud Console → create an OAuth client (type: Web application).
  - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
  - Consent screen scopes: only `openid`, `email` and `profile`.
- [ ] Supabase → Authentication → Providers → Google: paste the client ID and secret.
- [ ] Turn it on for a Pages project: `printf on | npx wrangler pages secret put GOOGLE_SIGN_IN --project-name <project>`.
- [ ] To use Google locally: set `[auth.external.google] enabled = true` in `config.toml`, export `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`, restart Supabase, and add `GOOGLE_SIGN_IN=on` to `apps/web/.dev.vars`. Also add `http://127.0.0.1:54321/auth/v1/callback` to the OAuth client's redirect URIs.

**Account deletion schedule (not set up yet).**
- [ ] The `delete-accounts` Edge Function deploys with the rest (CI deploys every folder in `supabase/functions`). Nothing calls it on a schedule yet. Until a daily trigger exists (pg_cron + pg_net, planned with the other jobs in Phase 12), accounts past their 14 days aren't purged. To run it by hand:
  ```bash
  curl -X POST -H "Authorization: Bearer <service-role key>" https://<project-ref>.supabase.co/functions/v1/delete-accounts
  ```

## 7. Email forwarding (Phase 6), waiting on the domain
Everything is built and tested locally. Hosted email needs a domain on Cloudflare, which costs money, so it waits.
- [ ] Add the domain to Cloudflare, then **Email → Email Routing** on the subdomain `in.<domain>`, with a **catch-all** rule sending to the Worker `feedcal-email-worker-staging` (and `-production`).
- [ ] Make one signing secret per environment and put the same value in both places (you paste it; it never goes in the repo):
  ```bash
  openssl rand -hex 32
  npx wrangler secret put INGEST_HMAC_SECRET --env staging -c apps/email-worker/wrangler.toml
  npx supabase secrets set --project-ref <staging ref> INGEST_HMAC_SECRET=<same value> INTAKE_DOMAIN=in.<domain>
  ```
- [ ] Deploy the Worker: `npx wrangler deploy --env staging -c apps/email-worker/wrangler.toml`.
- [ ] Set `INTAKE_DOMAIN` on the Pages project: `printf 'in.<domain>' | npx wrangler pages secret put INTAKE_DOMAIN --project-name feedcal-web-staging`.
- [ ] Run the Phase 6 hand test in docs/TESTING.md.

Locally: `supabase/functions/.env` (gitignored) holds a local-only `INGEST_HMAC_SECRET`; make one with `printf 'INGEST_HMAC_SECRET=%s\n' "$(openssl rand -hex 32)" > supabase/functions/.env`, then restart Supabase. Add `INTAKE_DOMAIN=in.feedcal.test` to `apps/web/.dev.vars` to see a full address on the email page.

## 8. AI extraction (Phase 9), optional and paid
Without a key, emails are parsed and triaged, then wait at extraction ("waiting", reason `no_api_key`). To switch it on:
- [ ] Create an Anthropic API key with a monthly spend limit at console.anthropic.com (you paste it; it never goes in the repo).
- [ ] `npx supabase secrets set --project-ref <ref> ANTHROPIC_API_KEY=<key>` (this also turns on vision reading of photos and scans, Phase 8).
- [ ] Send waiting emails back through: run `select public.requeue_waiting_extractions();` in the Supabase SQL editor.
- [ ] Optional: measure the real models on the evaluation set (see docs/TESTING.md).

## 9. Notification email (Phase 12), needs a domain
Locally, emails go to Mailpit (http://127.0.0.1:54324): `supabase/functions/.env` holds `MAILPIT_URL=http://supabase_inbucket_feedcal:8025` and `SITE_URL`. Hosted, until a provider is set, notifications stay queued (nothing is lost; they send once one is configured).
- [ ] With the domain verified at Resend (free tier), set Supabase secrets: `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `Feedcal <notifications@in.<domain>>`), `SITE_URL` (the site's address).

## 10. Directory data (Phase 13), your call
- [ ] **ZIP codes.** The directory's "near me" needs ZIP centroids. Download and unzip the Census ZCTA gazetteer (public domain, about 1 MB): https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip, then `npm run zcta:load -- 2024_Gaz_zcta_national.txt` (local), or with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in your own terminal for a hosted project. It has no city names; pages show the ZIP instead.
- [ ] **Imported Sacramento calendars.** The importer is built (daily, labelled with the source). Choosing which real public calendars to list is yours: add each with `select public.add_imported_feed('<name>', '<https .ics url>', '<source name>', '<category>', '<zip>', '<your user id>');` in the SQL editor. Only list calendars their owners publish for public use.

## 11. Moderation (Phase 14)
- [ ] Make yourself an admin: in the SQL editor, `insert into public.admins (user_id) select id from auth.users where email = '<your email>';`.
- [ ] Check that TOTP MFA is on for each hosted project (Authentication → Multi-Factor; Supabase's docs say it's on by default). Then open `/admin`: it asks you to set up an authenticator app before showing the queue.
- [ ] Have a lawyer review `/terms`, `/rules` and `/takedown` (drafts) before public launch.

## When it's all done
Merge a pull request into `main`: CI passes, staging deploys, and `https://feedcal-web-staging.pages.dev/health` returns `"status":"ok"`. For production, push a tag like `v0.1.0` and approve the `production` deployment in GitHub.
