-- D70: the standard bar for publishing without the owner drops from 85% to 70% (owner's decision).
-- A calendar that set its own bar keeps it. The functions that carry the default are rewritten
-- in place from their current definitions, so nothing else in them changes.
do $$
declare
  f record;
  n integer := 0;
begin
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname in ('public', 'private') and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%coalesce(f.auto_publish_threshold, 0.85)%'
  loop
    execute replace(f.def, 'coalesce(f.auto_publish_threshold, 0.85)', 'coalesce(f.auto_publish_threshold, 0.70)');
    n := n + 1;
  end loop;
  if n = 0 then
    raise exception 'publish bar: no function carries the 85%% default; nothing was changed';
  end if;
end;
$$;
