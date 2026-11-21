# Owner setup (things only you can do)

Phase 1 is scaffolded and its local checks pass. These steps unlock the rest of its "passes when." Nothing here has been done yet.

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

## 2. GitHub
- [ ] Create a **private** repo and push `main`.
- [ ] Set up branch and environment protection as in `docs/CONTRIBUTING.md`.
- [ ] If the repo belongs to an organization, gitleaks-action needs a free license key (`GITLEAKS_LICENSE` secret) (`UNVERIFIED` — check gitleaks-action README).

## 3. Supabase
- [ ] Create two projects: `feedcal-staging`, `feedcal-production` (Pro plan for production).
- [ ] Note each project's ref, database password, URL and anon key.
- [ ] Create a personal access token (Account → Access Tokens).

## 4. Cloudflare
- [ ] Add the domain to Cloudflare.
- [ ] Create Pages projects `feedcal-web-staging` and `feedcal-web` (direct upload).
- [ ] For each, set `SUPABASE_URL` (variable) and `SUPABASE_ANON_KEY` (secret): `npx wrangler pages secret put SUPABASE_ANON_KEY --project-name <project>`. Set `ENVIRONMENT` to `staging` / `production`.
- [ ] Create an API token with *Cloudflare Pages: Edit* (and later *Workers Scripts: Edit*). Note your account id.

## 5. GitHub environment secrets
In both `staging` and `production` environments, add:
`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Add environment variables `STAGING_URL` / `PRODUCTION_URL` (for the post-deploy `/health` smoke test).

## 6. Sign-in (Phase 3), for each hosted Supabase project
Local sign-in needs none of this: Mailpit at http://127.0.0.1:54324 catches the emails. The hosted projects need these steps. Menu names below are `UNVERIFIED`; check them in the dashboard.

**Email sending (Resend or Postmark).** Pick one.
- [ ] Create an account and verify your domain. Add the **SPF** and **DKIM** DNS records it gives you in Cloudflare DNS.
- [ ] Add a **DMARC** record. Start with `v=DMARC1; p=none; rua=mailto:<your address>`, and tighten it later.
- [ ] In Supabase → Authentication → Emails → SMTP settings, enter the provider's host, port, user and API key. The sender is `Feedcal <signin@your-domain>`. The key goes only here, never in the repo.
- [ ] Without custom SMTP, Supabase's built-in sender is rate-limited and meant only for testing (`UNVERIFIED`: check the current limit in Supabase's docs).

**Auth settings.**
- [ ] Authentication → URL Configuration:
  - **Site URL** = the environment's web address, for example `https://staging.your-domain`.
  - **Redirect URLs** = only `https://<that address>/auth/callback`. Use the exact address, without wildcards.
- [ ] Authentication → Emails → Templates: paste `supabase/templates/magic_link.html` into both **Magic Link** and **Confirm signup**, with the subject "Your Feedcal sign-in link".
- [ ] Email OTP expiry: **900** seconds (15 minutes).
- [ ] Rate limits: start with the values in `supabase/config.toml` `[auth.rate_limit]`.
- [ ] Optional: `supabase config push` may apply these settings from `config.toml` instead (`UNVERIFIED`: check that the CLI covers each one).

**Google sign-in.**
- [ ] Google Cloud Console → create an OAuth client (type: Web application).
  - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
  - Consent screen scopes: only `openid`, `email` and `profile`.
- [ ] Supabase → Authentication → Providers → Google: paste the client ID and secret.
- [ ] Cloudflare Pages project → set the variable `GOOGLE_SIGN_IN` to `on`.
- [ ] To use Google locally: set `[auth.external.google] enabled = true` in `config.toml`, export `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`, restart Supabase, and add `GOOGLE_SIGN_IN=on` to `apps/web/.dev.vars`. Also add `http://127.0.0.1:54321/auth/v1/callback` to the OAuth client's redirect URIs.

**Account deletion schedule (not set up yet).**
- [ ] The `delete-accounts` Edge Function deploys with the rest (CI deploys every folder in `supabase/functions`). Nothing calls it on a schedule yet. Until a daily trigger exists (pg_cron + pg_net, planned with the other jobs in Phase 12), accounts past their 14 days aren't purged. To run it by hand:
  ```bash
  curl -X POST -H "Authorization: Bearer <service-role key>" https://<project-ref>.supabase.co/functions/v1/delete-accounts
  ```

## When it's all done
Open a pull request: all three CI jobs should pass. Merge it: staging deploys, and `STAGING_URL/health` returns `"status":"ok"`.
