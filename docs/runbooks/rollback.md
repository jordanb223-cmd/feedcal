# Rollback: undo a bad release

Calantern has three parts that change in a release, and each goes back a different way.

| Part | How fast | How |
|---|---|---|
| Website (Cloudflare Pages) | Instant | Roll back in the Cloudflare dashboard |
| Background functions (Supabase Edge Functions) | ~10 minutes | Revert the change in a pull request and release it |
| Database (migrations) | Depends | Fix forward; restore the pre-release backup only for lost data |

## 1. Website: instant

Cloudflare's docs (checked 2026-11-21, developers.cloudflare.com/pages/configuration/rollbacks): "go to Deployments in your Pages project. Browse the All deployments list and select the three dotted actions menu for the desired target. Select Rollback to this deployment". Any successful production deployment that hasn't been deleted qualifies (deployments older than 30 days are deleted, except the 100 most recent and the current one).

1. Cloudflare → Workers & Pages → `feedcal-web` → Deployments.
2. Find the deployment for the previous release (its commit matches the previous tag's commit).
3. ⋯ → **Rollback to this deployment** → confirm.
4. Check `https://feedcal-web.pages.dev/health`: its `version` should be the previous one.

This is safe when the release's database changes only *added* things (new functions, columns, tables), which is the rule here: the old website ignores what it doesn't know.

## 2. Background functions: release the revert

Functions are only deployed by the production workflow, so going back is a new release:

1. On GitHub, open the release's pull request → **Revert** (or `git revert <merge commit>` on a branch).
2. Bump the version, add a CHANGELOG line ("Reverted …"), merge when CI passes, tag the next version, approve the deploy.

Don't re-run an older release's deploy workflow: the database now has migrations that release doesn't know, and `supabase db push` refuses to run (expected from how `db push` compares migration lists; not tested). Tags can't be moved or deleted (GitHub ruleset "Protect release tags"), which is on purpose.

## 3. Database: fix forward, restore only for lost data

Migrations aren't reversed. If a migration is wrong, write a new migration that corrects it and release it as in step 2.

If data was lost or damaged, every production deploy takes a backup first (`backup-predeploy-<tag>-<run>`, kept 90 days, also copied weekly to `~/Documents/Calantern Backups`). Follow `restore.md`. Restoring production replaces everything written since that backup (new events, sign-ups, reports), so first export or note anything newer you need to keep.

## Which one?

- The site looks broken or errors after a release → **1**, then fix and release.
- Emails stop being read, events stop appearing, notifications misbehave → **2**.
- Data is missing or wrong → stop further changes, then **3**.
