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

After any migration: `npm run db:types` and commit `packages/shared/src/database.types.ts`. If the migration changes a state machine, also run `npm run db:states` (see docs/STATE-MACHINES.md). CI fails if either is stale.

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

## Rules for every screen and form

- **Empty state.** Every list says what it is when it's empty, and what to do next ("You don't have any feeds yet").
- **Error state.** Every screen has a plain-English error: what happened, what to try. Unexpected errors fall through to the HTML error page with the request id (`errorPage` in `views.ts`); JSON routes keep JSON.
- **Keep what was typed.** A form that fails validation shows the user's input again (escaped), never a blank form.
- **Redirect after POST (PRG).** A successful POST answers with a 303 to a GET page, so refresh can't resubmit.
- **Safe to submit twice.** Any action that creates something must be idempotent: a double tap or a retry makes one thing, not two (a unique key or dedupe row in Postgres).
- **User text is marked `dir="auto"`** (titles, descriptions, names, locations), so Arabic and Hebrew display correctly.
- **Integration tests** (`npm run test:integration`) run against the local stack with real sessions. Add one when a rule depends on RLS across two users.

## Rules

Read `docs/BUILD-PLAN.md` (engineering discipline block) before starting a phase. No secrets in code, logs, tests or commits.
