-- D85: the owner's decision. Events that were read correctly were being held at 55%, 60% and 80%.
-- The standard bar for publishing without the owner drops from 70% to 45%, and the bar for events
-- read from a picture drops from 85% to the same 45%. A calendar that set its own bar keeps it.
-- The functions are rewritten in place from their current definitions, so nothing else changes.
do $$
declare
  f record;
  n integer := 0;
  m integer := 0;
begin
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname in ('public', 'private') and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%coalesce(f.auto_publish_threshold, 0.70)%'
  loop
    execute replace(f.def, 'coalesce(f.auto_publish_threshold, 0.70)', 'coalesce(f.auto_publish_threshold, 0.45)');
    n := n + 1;
  end loop;
  if n = 0 then
    raise exception 'publish bar: no function carries the 70%% default; nothing was changed';
  end if;

  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'private' and p.proname = 'reconcile_candidate' and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%greatest(v_threshold, 0.85)%'
  loop
    execute replace(f.def, 'greatest(v_threshold, 0.85)', 'greatest(v_threshold, 0.45)');
    m := m + 1;
  end loop;
  if m <> 1 then
    raise exception 'picture bar: expected to change reconcile_candidate once, changed % functions', m;
  end if;
end;
$$;
