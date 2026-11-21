# Contributing

## Daily loop

```bash
npm install
npm run db:start      # needs Docker
npm run db:reset      # apply migrations + seed
npm run lint && npm run typecheck && npm test && npm run db:test
npm run dev:web       # http://localhost:8788/health
```

After any migration: `npm run db:types` and commit `packages/shared/src/database.types.ts`. CI fails if it's stale.

## Branches and releases

- Work on a branch, open a pull request into `main`.
- `main` deploys to staging automatically after CI passes.
- Production deploys only from a tag `vX.Y.Z`, and waits for approval on the `production` environment.

## Branch protection (set in GitHub → Settings → Branches → `main`)

- Require a pull request before merging; require 1 approval (or 0 while solo, but keep the PR).
- Require status checks: `Lint, typecheck, unit tests, build, audit`, `Migrations, pgTAP, generated types`, `Secret scan`.
- Require branches to be up to date before merging.
- Block force pushes and deletions.

## Environment protection (GitHub → Settings → Environments)

- `staging`: no reviewers; restrict to `main`.
- `production`: required reviewer = repo owner; restrict to tags `v*`.

## Rules

Read `docs/BUILD-PLAN.md` (engineering discipline block) before starting a phase. No secrets in code, logs, tests or commits.
