#!/usr/bin/env bash
# D65: after a backup is safely stored, tell the database it happened, so the alert check can
# email the admins if backups stop. Run only once the encrypted file is uploaded.
#   scripts/backup-heartbeat.sh <db-url> <source> <file>
set -euo pipefail
url="${1:?usage: backup-heartbeat.sh <db-url> <source> <file>}"
source="${2:?source}"
file="${3:?file}"
bytes="$(wc -c < "$file" | tr -d ' ')"
[[ "$source" =~ ^[a-z-]{1,40}$ ]] || { echo "bad source" >&2; exit 1; }
[[ "$bytes" =~ ^[0-9]+$ ]] || { echo "bad size" >&2; exit 1; }
sql="select private.record_backup('$source', $bytes)"
if ! command -v psql >/dev/null 2>&1; then
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    sudo apt-get install -y -qq postgresql-client >/dev/null   # GitHub's Ubuntu runners normally have it already
  else
    echo "psql isn't installed; nothing recorded." >&2; exit 1
  fi
fi
psql "$url" -v ON_ERROR_STOP=1 -qAt -c "$sql" >/dev/null
echo "Recorded the backup ($bytes bytes, $source)."
