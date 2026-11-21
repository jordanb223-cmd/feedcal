# Contributing

## Daily loop

```bash
npm install
colima start          # Docker engine (or Docker Desktop, if you prefer)
npm run db:start
npm run db:reset      # apply migrations + seed
npm run lint && npm run typecheck && npm test && npm run db:test
npm run dev:web       # http://localhost:8788/health
```

After any migration: `npm run db:types` and commit `packages/shared/src/database.types.ts`. CI fails if it's stale.

## Branches and releases

- Work on a branch, open a pull request into `main`.
- `main` deploys to staging automatically after CI passes.
- Production deploys only from a tag `vX.Y.Z`, and waits for approval on the `production` environment.

## Merging and your email
GitHub's "Keep my email addresses private" setting is on (2026-11-20), so merges made on GitHub use the no-reply address. This checkout's git uses it too. After merging, check the public commit emails:
```bash
curl -s https://api.github.com/repos/jordanb223-cmd/feedcal/commits | grep -o '"email": "[^"]*"' | sort -u
```

## Branch protection (set in GitHub → Settings → Branches → `main`)

- Require a pull request before merging; 0 approvals while solo (set 2026-11-20).
- Require status checks: `Lint, typecheck, unit tests, build, audit`, `Migrations, pgTAP, generated types`, `Secret scan`.
- Require branches to be up to date before merging.
- Block force pushes and deletions.

## Environment protection (GitHub → Settings → Environments)

- `staging`: no reviewers; restrict to `main`.
- `production`: required reviewer = repo owner; restrict to tags `v*`.

## Rules

Read `docs/BUILD-PLAN.md` (engineering discipline block) before starting a phase. No secrets in code, logs, tests or commits.
