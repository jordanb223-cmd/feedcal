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

## Safety rails (D57)

Each rule below has a control that enforces it, and a safe command to use instead.

| Rule | What enforces it | Safe command |
|---|---|---|
| Tests never touch a hosted database | `tests/integration/local-stack.ts` stops the run unless the API and database hosts are `127.0.0.1`/`localhost` | `npm run test:integration` |
| `db:reset` only wipes the local database | `scripts/db-reset.mjs` refuses `--linked`, `--db-url`, `--project-ref` | `npm run db:reset` |
| Production is backed up right before every change | `deploy-production.yml` runs `scripts/backup.sh` and keeps the copy 90 days (`backup-predeploy-…` artifact); if the backup fails, production isn't touched (D58) | `scripts/restore-drill.sh <file>` to restore into the local stack |
| Migrations that delete or rewrite data are flagged | `.github/scripts/migration-guard.sh` runs on every pull request (a required check) and again in the deploy. It flags drop table/schema/column/sequence/extension/materialized view, truncate, run-time `delete from` and column type changes, and fails until the file has `-- destructive: reviewed`. That line is a self-declaration anyone can add; the pre-deploy backup is the real safety net | add the line in the PR after checking it |
| Hosted databases and sites change only through the deploy | `.claude/settings.json` denies agents `supabase db push`, `supabase link`, `db reset --linked/--db-url`, `wrangler pages deploy`, project deletes; production needs the owner's approval (environment protection above) | tag `vX.Y.Z` and approve the run |
| No force-push, repo deletion, or secret changes from an agent | `.claude/settings.json` deny rules; branch protection on `main` | `gh pr create` / `gh pr merge --squash` |
| Agents don't read local secrets files | `.claude/settings.json` denies reading `.dev.vars`, `supabase/functions/.env`, `.env*` | use `.dev.vars.example` |

How far the agent rules reach (Claude Code docs, checked 2026-11-21): deny rules block in every permission mode; they match past `FOO=1` prefixes and inside `&&` chains, and `Read` denies also cover `cat`, `head`, `tail`, `sed` and `tee`. They do **not** stop `bash -c "…"`, a program called by its full path (`/bin/rm`, `node_modules/.bin/supabase`), a script that opens files itself, or `git push origin :branch`. They load only when a session starts in this folder. The scripts, CI and GitHub settings are the backstop.

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
