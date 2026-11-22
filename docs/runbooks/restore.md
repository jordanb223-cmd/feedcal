# Restore the database from a backup

D37. Backups: `.github/workflows/backup.yml`, daily at 09:20 UTC, encrypted with `BACKUP_PASSPHRASE`. Daily copies are kept 7 days and Sunday's copy 90 days (GitHub's retention limit for the repository applies; 90 days is the usual maximum, UNVERIFIED for this repo).

## Drill (do this monthly, and after any schema change)
1. Start the local stack: `npx supabase start`.
2. Download yesterday's artifact from Actions → Backup → the run → Artifacts, and unzip it to get `feedcal-<time>.tar.gz.enc`.
3. Run the drill. It **wipes local data**:
   ```bash
   BACKUP_PASSPHRASE='<from your password manager>' scripts/restore-drill.sh path/to/feedcal-<time>.tar.gz.enc
   ```
4. Check the counts it prints against production's (Supabase SQL editor: `select count(*) from public.feeds` and so on). `feed_tokens_readable` will be 0 locally: Vault secrets only decrypt in the project that made them. That's expected.
5. Record the date and result in DECISIONS (under D37, "Restore drills").

With no file, `scripts/restore-drill.sh` drills the local database itself: it backs up, wipes, restores, then compares counts and an events checksum.

## A real restore (production lost or corrupted)
1. First try Supabase's own backups (dashboard → Database → Backups), if the plan includes them.
2. Otherwise, make a fresh project. Apply the migrations (the deploy does this), then load `data.sql` from the decrypted backup with `psql` and `session_replication_role = replica`. **Skip `vault.sql`** in a new project: its secrets only decrypt in the project that made them.
3. What that costs: subscribers' calendar links keep working, because feeds are looked up by hash. But the tokens themselves can't be shown again, so public pages' subscribe buttons and share kits break for old feeds until each owner uses "Make a new link". The migrations make a new unsubscribe key and sign-in salt, so unsubscribe links in old emails stop working.
4. Re-run the deploy so `app_settings` (the functions URL and key) and cron are set, then check `/health`.

## When backups stop

Trigger: the "No database backup in over 30 hours" alert email (D65).

1. GitHub → Actions → **Backup** → **Run workflow**. Watch the run.
2. If it fails at "Dump and encrypt": check the `BACKUP_DB_URL` secret still works (the database password may have changed) and that Supabase is up.
3. If it fails at "Tell the database a backup was stored": the backup itself is safe in the run's artifacts; the alert clears with the next successful run.
4. If runs simply aren't starting: GitHub drops scheduled runs when it's busy. Backups are scheduled four times a day for that reason; a manual run counts the same. Deploys also take a backup first.
5. The alert clears by itself within 5 minutes of the next successful backup.

