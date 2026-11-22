#!/usr/bin/env bash
# Safety guard (D57): run by deploy.sh before `supabase db push`.
#   migration-guard.sh <migrations-dir> <environment>   (applied versions on stdin, one per line)
# For every migration not yet applied, look for statements that delete data or tables. Each one
# prints a WARNING naming the file and the environment. The push is refused unless the file has
# the line `-- destructive: reviewed`, added in the pull request after a person has checked it.
# That line is a self-declaration: anyone editing the file can add it. The real safety net is the
# backup the production deploy takes right before migrating (D58).
set -euo pipefail
dir="${1:?usage: migration-guard.sh <migrations-dir> <environment>}"
envname="${2:?usage: migration-guard.sh <migrations-dir> <environment>}"
applied="$(cat)"
# Data that can't come back without a restore: drop table / schema / database / column /
# materialized view / sequence / extension (extensions such as pgmq own tables), truncate,
# delete from, and changing a column's type (a cast can lose data). drop function / policy /
# index only change code and are not flagged.
pattern='(^|[^a-z_])(drop[[:space:]]+(table|schema|database|column|sequence|extension)|drop[[:space:]]+materialized[[:space:]]+view|truncate|delete[[:space:]]+from|alter[[:space:]]+column[[:space:]]+[^[:space:]]+[[:space:]]+(set[[:space:]]+data[[:space:]]+)?type)([^a-z_]|$)'
pending=0 flagged=0 blocked=0
for f in "$dir"/*.sql; do
  [ -e "$f" ] || continue
  version="$(basename "$f" | cut -d_ -f1)"
  if printf '%s\n' "$applied" | grep -qx -- "$version"; then continue; fi
  pending=$((pending + 1))
  # Comments and function bodies ($$…$$) don't run at migration time, so they're left out;
  # `do $$ … $$` blocks do run, so they're kept.
  code="$(perl -0777 -pe 's/--[^\n]*//g; s/(\bdo\s+)?(\$\w*\$)(.*?)\2/defined $1 ? "$1$2$3$2" : ""/gesi' "$f")"
  if printf '%s' "$code" | grep -qiE "$pattern"; then
    flagged=$((flagged + 1))
    echo "::warning file=$f::WARNING: $(basename "$f") DELETES or rewrites data in the $envname database (drop/truncate/delete/type change). It can't be undone without restoring a backup."
    if ! grep -q -- '-- destructive: reviewed' "$f"; then
      echo "REFUSING to push to $envname: add the line '-- destructive: reviewed' to $(basename "$f") once a person has checked what it deletes." >&2
      blocked=1
    fi
  fi
done
echo "Migrations not yet applied to $envname: $pending (flagged as deleting data: $flagged)."
exit "$blocked"
