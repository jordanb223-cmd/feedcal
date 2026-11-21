# Runbook: the owner's laptop is lost or stolen

Do these in order, from another device. Most take a minute each. Tick them off as you go.

## 1. Cut off GitHub (the code and the deploy pipeline)
- [ ] github.com → Settings → **Sessions**: sign out every session you don't recognise.
- [ ] github.com/settings/applications → **Authorized OAuth Apps**: revoke **GitHub CLI** (this is the token `gh auth login` made on the laptop).
- [ ] github.com/settings/tokens: delete any personal access token that lived on the laptop.
- [ ] github.com/settings/keys: delete the laptop's SSH keys.
- [ ] Later, on the new machine: `gh auth login` again.

## 2. Rotate the deploy tokens
These two are stored as GitHub secrets. Whoever has the laptop may have copies.
- [ ] **Supabase access token**: supabase.com/dashboard/account/tokens → delete the old one → create a new one.
- [ ] **Cloudflare API token**: dash.cloudflare.com → My Profile → API Tokens → **Roll** (or delete and recreate with the same permissions: see docs/SETUP.md §5).
- [ ] GitHub repo → Settings → Secrets and variables → Actions: update `SUPABASE_ACCESS_TOKEN` and `CLOUDFLARE_API_TOKEN`.
- [ ] Run **Deploy staging** from the Actions tab and check `/health`, to prove the new tokens work.

## 3. Rotate app secrets if the laptop held them
- [ ] If `.dev.vars` held anything other than the local demo key, rotate it.
- [ ] When the ingest HMAC secret exists (Phase 6): set a new one with `wrangler secret put INGEST_HMAC_SECRET` for each environment, and the same value in Supabase secrets.

## 4. Sign out of dashboards everywhere
- [ ] Supabase: change your password (or your GitHub/Google sign-in's password), which ends other sessions.
- [ ] Cloudflare: My Profile → Sessions → revoke others.
- [ ] Google account (if used for Gmail forwarding tests): myaccount.google.com → Security → Your devices → sign out the laptop.

## 5. The laptop itself
- [ ] Find My → mark as lost, then erase.
- [ ] Confirm FileVault was on. (On the new Mac: System Settings → Privacy & Security → FileVault. If it was on, data at rest is encrypted, and steps 1–4 are a precaution rather than a certainty that something leaked.)

## 6. Write it down
- [ ] Add a line to CHANGELOG.md under "Security" if users were affected. Otherwise note the date in a private log.
