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

## When it's all done
Open a pull request: all three CI jobs should pass. Merge it: staging deploys, and `STAGING_URL/health` returns `"status":"ok"`.
