-- Health probe for GET /health. Returns true and touches no tables, so
-- granting it to anon reveals nothing.
create or replace function public.health_check()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select true $$;

revoke all on function public.health_check() from public;
grant execute on function public.health_check() to anon, authenticated;
