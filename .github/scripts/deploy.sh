#!/usr/bin/env bash
# Deploys one environment: database migrations, Edge Functions, web app.
# Called by deploy-staging.yml and deploy-production.yml.
#
# Needs (env): ENVIRONMENT (staging|production), SUPABASE_PROJECT_REF, PAGES_PROJECT,
#   SITE_URL, DEPLOY_SHA, SUPABASE_ACCESS_TOKEN (secret), CLOUDFLARE_API_TOKEN (secret),
#   CLOUDFLARE_ACCOUNT_ID.
# No database password: with --remote and no --password, Supabase CLI 3.x connects using
# the access token (`supabase db push --help`, "Scoped access token ... database_write").
set -euo pipefail

: "${ENVIRONMENT:?}" "${SUPABASE_PROJECT_REF:?}" "${PAGES_PROJECT:?}" "${SITE_URL:?}" "${DEPLOY_SHA:?}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN secret is not set (docs/SETUP.md)}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN secret is not set (docs/SETUP.md)}"
: "${CLOUDFLARE_ACCOUNT_ID:?}"
export SUPABASE_YES=1  # hosted changes need an explicit yes in non-interactive runs

echo "::group::Database migrations ($ENVIRONMENT)"
npx supabase link --project-ref "$SUPABASE_PROJECT_REF"
npx supabase db push --remote
echo "::endgroup::"

echo "::group::Edge Functions"
if ls supabase/functions/*/index.ts >/dev/null 2>&1; then
  npx supabase functions deploy --use-api
else
  echo "No Edge Functions."
fi
echo "::endgroup::"

echo "::group::Cloudflare Pages project and runtime settings"
if ! npx wrangler pages project list --json | jq -e --arg p "$PAGES_PROJECT" 'any(.[]; (.name // ."Project Name") == $p)' >/dev/null; then
  npx wrangler pages project create "$PAGES_PROJECT" --production-branch main
fi
# The public (anon/publishable) key is safe in browsers; RLS protects the data.
# The first hosted run (2026-11-21) showed the JSON isn't a flat list of keys ("Cannot index
# array with string name"). So search every object at any depth for the anon or publishable
# key, and take whichever value field it has. Only the key's value is printed, never the object.
ANON_KEY="$(npx supabase projects api-keys --output-format json \
  | jq -r 'first(.. | objects | select(.name == "anon" or .type == "publishable" or .id == "anon")
           | (.api_key // .key // .value // empty) | select(type == "string" and length > 20)) // empty')"
if [ -z "$ANON_KEY" ]; then echo "Could not read the project's public API key." >&2; exit 1; fi
echo "::add-mask::$ANON_KEY"
# Each Pages project deploys "main" as its production environment, so per-environment
# values are set on the project itself, not in wrangler.toml (D21).
printf '%s' "$ENVIRONMENT" | npx wrangler pages secret put ENVIRONMENT --project-name "$PAGES_PROJECT"
printf '%s' "https://$SUPABASE_PROJECT_REF.supabase.co" | npx wrangler pages secret put SUPABASE_URL --project-name "$PAGES_PROJECT"
printf '%s' "$ANON_KEY" | npx wrangler pages secret put SUPABASE_ANON_KEY --project-name "$PAGES_PROJECT"
# The Buy Me a Coffee page name (D36), from the repository variable BMC_USERNAME. Public, not a
# secret; unset means no donation link is shown.
if [ -n "${BMC_USERNAME:-}" ]; then
  printf '%s' "$BMC_USERNAME" | npx wrangler pages secret put BMC_USERNAME --project-name "$PAGES_PROJECT"
fi
echo "::endgroup::"

echo "::group::Scheduler settings (where pg_cron finds the Edge Functions)"
# Management API "Run sql query" (experimental): supabase.com/docs/reference/api/v1-run-a-query.
# Not yet run against a hosted project.
# Values are the public project URL and public anon key, not secrets (D26).
SETTINGS_SQL="insert into private.app_settings (key, value) values
  ('functions_url', 'https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1'),
  ('functions_key', '$ANON_KEY')
  on conflict (key) do update set value = excluded.value;"
jq -n --arg q "$SETTINGS_SQL" '{query: $q}' | curl --fail --silent --show-error -X POST \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "content-type: application/json" --data @- >/dev/null
echo "::endgroup::"

echo "::group::Web app"
GITHUB_SHA="$DEPLOY_SHA" npm run build -w @feedcal/web
npx wrangler pages deploy apps/web/dist --project-name "$PAGES_PROJECT" --branch main --commit-hash "$DEPLOY_SHA"
echo "::endgroup::"

echo "::group::Smoke test"
curl --fail --silent --show-error --retry 6 --retry-delay 10 --retry-all-errors "$SITE_URL/health"
echo
echo "::endgroup::"
