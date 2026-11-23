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
- [ ] **Branded template.** Supabase only lets you edit email templates once custom SMTP is set. Then paste `supabase/templates/magic_link.html` into **Magic link or OTP** and **Confirm sign up**, with the subject "Your Calantern sign-in link".
- [ ] **Until then,** hosted projects send Supabase's default email. Its link goes through Supabase to `/auth/callback`, so sign-in works. Staging lacks two things until then: the "Continue" button that guards against link scanners, and the specific "expired or already used" message. Expired links get a general "try again". Supabase's built-in sender is for testing only and may only deliver to your own team's addresses (`UNVERIFIED`).

**Google sign-in.** Done for **production** on 2026-11-21 (v0.1.3): the Google Cloud project "Feedcal" with a Web OAuth client, Supabase's Google provider, and the production environment variable `GOOGLE_SIGN_IN=on`. Tested by the owner. Staging is not set up (optional).
- [ ] Google Cloud Console → create an OAuth client (type: Web application).
  - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
  - Consent screen scopes: only `openid`, `email` and `profile`.
- [ ] Supabase → Authentication → Providers → Google: paste the client ID and secret.
- [ ] Turn it on for an environment: in GitHub, **Settings → Environments → production** (or staging) **→ Add variable** `GOOGLE_SIGN_IN` = `on`. The next deploy shows the button.
- [ ] To use Google locally: set `[auth.external.google] enabled = true` in `config.toml`, export `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`, restart Supabase, and add `GOOGLE_SIGN_IN=on` to `apps/web/.dev.vars`. Also add `http://127.0.0.1:54321/auth/v1/callback` to the OAuth client's redirect URIs.

**Account deletion schedule.** Since Phase 16 (D37), pg_cron calls `delete-accounts` every day at 04:41 UTC, as it does the other jobs. Nothing to set up beyond the deploy. To run it by hand:
  ```bash
  curl -X POST -H "Authorization: Bearer <anon key>" https://<project-ref>.supabase.co/functions/v1/delete-accounts
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
- [ ] **ZIP codes.** Easiest: GitHub → Actions → **Load ZIP codes** → Run workflow, choosing staging or production. GitHub's machine downloads the Census file and loads it with the deploy token. By hand instead: the directory's "near me" needs ZIP centroids. Download and unzip the Census ZCTA gazetteer (public domain, about 1 MB): https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip, then `npm run zcta:load -- 2024_Gaz_zcta_national.txt` (local), or with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in your own terminal for a hosted project. It has no city names; pages show the ZIP instead.
- [ ] **Imported Sacramento calendars.** The importer is built (daily, labelled with the source). Choosing which real public calendars to list is yours: add each with `select public.add_imported_feed('<name>', '<https .ics url>', '<source name>', '<category>', '<zip>', '<your user id>');` in the SQL editor. Only list calendars their owners publish for public use.

## 11. Moderation (Phase 14)
- [x] Make yourself an admin (done; confirmed in production 2026-11-22, added 2026-11-21): in the SQL editor, `insert into public.admins (user_id) select id from auth.users where email = '<your email>';`. **Needed for contact-form messages (D63) and operations alerts to reach you**: they're emailed to everyone in `public.admins`, and stored either way.
- [ ] Check that TOTP MFA is on for each hosted project (Authentication → Multi-Factor; Supabase's docs say it's on by default). Then open `/admin`: it asks you to set up an authenticator app before showing the queue.
- [ ] Have a lawyer review `/terms`, `/rules` and `/takedown` (drafts) before public launch.

## 12. Buy Me a Coffee donations (Phase 15), optional
- [x] Create a Buy Me a Coffee page (free; BMC takes a fee on donations). Done 2026-11-21: `buymeacoffee.com/jordanb223`. Its page name is the repository variable `BMC_USERNAME`, which each deploy passes to its Pages project. Without it, no donation link is shown.
- [ ] In BMC's dashboard, add a webhook pointing to `https://<project-ref>.supabase.co/functions/v1/bmc-webhook`. Choose the donation, membership and recurring-donation events.
- [ ] Copy its signing secret into the Supabase project: `npx supabase secrets set BMC_WEBHOOK_SECRET=<secret> --project-ref <ref>`. Never commit it.
- [ ] On **staging only**, also set `BMC_ACCEPT_TEST_EVENTS=true`, then send a test event from BMC's dashboard. Check that `private.bmc_events` has one row with outcome `applied`, then check the function's logs. If the outcome is `no_supporter`, BMC's field names differ from the guesses in `supabase/functions/_shared/bmc.ts` (D36). Send the log line (it holds no personal data) and that file gets fixed.
- [ ] Locally, `supabase/functions/.env` needs `BMC_WEBHOOK_SECRET=<any random text>` for the integration test.

## 13. Backups and security settings (Phase 16)
- [ ] **Backups.** Make a long random passphrase and keep it in your password manager; without it, backups can't be read. Add two repository secrets (GitHub → Settings → Secrets and variables → Actions): `BACKUP_PASSPHRASE`, and `BACKUP_DB_URL`, production's connection string (Supabase → Connect → session pooler URI, with the database password). The `Backup` workflow then runs daily. Run it once by hand (Actions → Backup → Run workflow), then do the restore drill in `docs/runbooks/restore.md`.
- [ ] **Advisor on hosted projects.** `npx supabase db advisors --remote` (after `supabase link`) for staging and production. Expect no warnings; send any output so it gets fixed.
- [ ] **HSTS.** Once the real domain serves HTTPS without problems for a week, raise HSTS on the Pages projects: `printf 31536000 | npx wrangler pages secret put HSTS_MAX_AGE --project-name <project>`.
- [ ] **Cloudflare rate limiting** (free plan: one rule), once the domain exists: limit `/f/*` per IP as a second layer to the app's own limit (THREAT-MODEL T2).
- [ ] **Lawyer review** of `/privacy` along with the other policy drafts.

## 14. Operations (Phase 18)
- [ ] **AI budget.** The default is a placeholder $10 a month. As an admin, in the SQL editor: `update private.ops_settings set monthly_ai_budget_usd = <amount>;`. AI work pauses at 80% of it (D38).
- [ ] **Alerts** go to everyone in `public.admins` (§11). After the first staging deploy, open `/admin` → Operations → "Run the alert drill" and check that six "[Drill]" emails arrive.
- [ ] **Uptime.** Add the repository variable `UPTIME_HEALTH_URLS` (Settings → Secrets and variables → Actions → Variables), for example `https://feedcal-web-staging.pages.dev/health https://<production>/health`. Add the secret `UPTIME_FEED_URL`: one feed link from a share page (it contains a token, so it's a secret). To test it, set a wrong URL for two runs: an "Outage" issue opens. Then fix the URL and close the issue.
- [ ] **Status page and support inbox** (need the domain). A shared address like `help@<domain>` through Cloudflare Email Routing, and a status page. The Uptime issues can be linked from it.
- [ ] **Error tracking and log search** (Prompt H items 80, 81): pick a tracker with a free tier that runs in Cloudflare Workers. Personal data must be scrubbed before sending. Not set up.
- [ ] **Beta.** Invite 10 organizers. Track wrong events per feed for 2 weeks (target: fewer than 1 in 20).

## 15. Gmail connection (Phase 17), free, test mode
Use a **separate** Google Cloud project from sign-in, so sign-in is never affected (D39).
- [ ] console.cloud.google.com: create a project named `Feedcal Gmail`. No billing needed.
- [ ] **APIs & Services → Library → Gmail API → Enable.**
- [ ] **OAuth consent screen** (Google Auth Platform): app name `Feedcal`, audience **External**, publishing status **Testing**. Add the scope `https://www.googleapis.com/auth/gmail.readonly`. Under **Test users**, add your Gmail (and each beta organizer's, up to 100).
- [ ] **Clients → Create OAuth client → Web application**, with the authorized redirect URI `https://<project-ref>.supabase.co/functions/v1/gmail-oauth`. Copy the client id and secret.
- [ ] Supabase → Edge Functions → Secrets: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`.
- [ ] GitHub → Settings → Environments → production → variables: `GMAIL_CLIENT_ID` (public). The next deploy shows "Connect Gmail" on each feed's Gmail page.
- [ ] Remember: in test mode the connection lasts 7 days; Feedcal emails a reminder.
- Test mode is the plan for now (D42): only people listed under **Test users** can connect, and everyone reconnects weekly. Leaving test mode means Google's restricted-scope verification plus a paid yearly security assessment; the free route for everyone is forwarding with a Gmail filter, once there's a domain.

## When it's all done
Merge a pull request into `main`: CI passes, staging deploys, and `https://feedcal-web-staging.pages.dev/health` returns `"status":"ok"`. For production, push a tag like `v0.1.0` and approve the `production` deployment in GitHub.
