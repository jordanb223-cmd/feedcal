# Owner setup (things only you can do)

Phase 1 is scaffolded and its local checks pass. These steps unlock the rest of its "passes when." Nothing here has been done yet.

## 1. Local database
- [ ] Install Docker Desktop and start it.
- [ ] In the repo: `npm run db:start`, then `npm run db:reset && npm run db:test`.
- [ ] Run `npm run db:types` and commit the regenerated `packages/shared/src/database.types.ts` (the committed file is a placeholder, so CI's stale-types check fails until you do this).
- [ ] Copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars`, paste the anon key from `npx supabase status`, run `npm run dev:web`, and open http://localhost:8788/health. It should say `"status":"ok"`.

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

## When it's all done
Open a pull request: all three CI jobs should pass. Merge it: staging deploys, and `STAGING_URL/health` returns `"status":"ok"`.
