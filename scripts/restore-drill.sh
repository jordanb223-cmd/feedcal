#!/usr/bin/env bash
# Phase 16 (D37): restore drill against the LOCAL stack (it wipes local data).
#   scripts/restore-drill.sh                 back up local data, wipe, restore, compare
#   scripts/restore-drill.sh <backup.enc>    restore a backup made by backup.sh (e.g. yesterday's
#                                            hosted backup) into the local stack and report counts
# Needs: the local stack running (npx supabase start), BACKUP_PASSPHRASE for an .enc file.
set -euo pipefail
db() { docker exec -i supabase_db_feedcal psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fingerprint() {
  db <<'SQL'
select string_agg(t || '=' || n, ' ' order by t) from (
  select 'auth.users' t, count(*) n from auth.users union all
  select 'profiles', count(*) from public.profiles union all
  select 'feeds', count(*) from public.feeds union all
  select 'feed_editors', count(*) from public.feed_editors union all
  select 'events', count(*) from public.events union all
  select 'event_revisions', count(*) from public.event_revisions union all
  select 'sources', count(*) from public.sources union all
  select 'messages', count(*) from public.messages union all
  select 'supporters', count(*) from public.supporters union all
  select 'vault.secrets', count(*) from vault.secrets) x;
select 'events_md5=' || coalesce(md5(string_agg(id::text || title || starts_at::text, ',' order by id)), 'none') from public.events;
select 'feed_tokens_readable=' || count(*) from public.feeds f join vault.decrypted_secrets ds on ds.id = f.feed_token_secret_id where ds.decrypted_secret is not null;
SQL
}
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ $# -ge 1 ]; then
  : "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -in "$1" | tar -C "$work" -xzf -
  echo "Backup taken at $(cat "$work/TAKEN_AT")"
  before=""
else
  before="$(fingerprint)"
  npx supabase db dump --data-only --use-copy -f "$work/data.sql" >/dev/null 2>&1
  npx supabase db dump --data-only --use-copy -s vault -f "$work/vault.sql" >/dev/null 2>&1
fi
echo "Wiping local data and re-applying migrations…"
npx supabase db reset --no-seed >/dev/null 2>&1
echo "Restoring…"
{
  echo "set session_replication_role = replica;"   # don't fire triggers on restored rows
  echo "delete from vault.secrets;"                 # migrations made fresh keys; the backup's win
  cat "$work/vault.sql"
  # Migrations seed some rows (state machines, storage buckets…); the backup holds them too,
  # so every table the backup contains is emptied first, then filled from the backup.
  tables="$(grep -oE '^COPY "[a-z_]+"\."[a-z_]+"' "$work/data.sql" | sed 's/^COPY //' | paste -sd, -)"
  [ -n "$tables" ] && echo "truncate $tables cascade;"
  cat "$work/data.sql"
} | db >/dev/null
after="$(fingerprint)"
echo "After restore:  $after" | tr '\n' ' '; echo
if [ -n "$before" ]; then
  echo "Before backup:  $before" | tr '\n' ' '; echo
  if [ "$before" = "$after" ]; then echo "RESTORE DRILL PASSED: every count and the events checksum match."; else echo "RESTORE DRILL FAILED: see the differences above."; exit 1; fi
fi
