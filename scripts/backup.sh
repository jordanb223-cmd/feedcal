#!/usr/bin/env bash
# Phase 16 (D37): a full logical backup of a Feedcal database, encrypted.
#   scripts/backup.sh <out-dir> [db-url]
# With no db-url it backs up the local stack. Output: <out-dir>/feedcal-<UTC time>.tar.gz.enc
# (AES-256, key from BACKUP_PASSPHRASE). Contents: roles, schema, data (auth, public, private)
# and Vault's encrypted secrets. Stored files (forwarded email originals, deleted after 30
# days anyway) are not included. Vault secrets only decrypt in the same Supabase project.
set -euo pipefail
out="${1:?usage: backup.sh <out-dir> [db-url]}"
url="${2:-}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
target=()
[ -n "$url" ] && target=(--remote="$url")
npx supabase db dump ${target[@]+"${target[@]}"} --role-only -f "$work/roles.sql"
npx supabase db dump ${target[@]+"${target[@]}"} -f "$work/schema.sql"
npx supabase db dump ${target[@]+"${target[@]}"} --data-only --use-copy -f "$work/data.sql"
npx supabase db dump ${target[@]+"${target[@]}"} --data-only --use-copy -s vault -f "$work/vault.sql"
date -u +%Y-%m-%dT%H:%M:%SZ > "$work/TAKEN_AT"
mkdir -p "$out"
name="feedcal-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.enc"
tar -C "$work" -czf - roles.sql schema.sql data.sql vault.sql TAKEN_AT \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_PASSPHRASE -out "$out/$name"
echo "$out/$name"
