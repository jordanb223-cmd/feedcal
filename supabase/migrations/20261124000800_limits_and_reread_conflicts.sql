-- D78.
-- 1. Daily picture pages per owner: 20 -> 100. The limit was set when every picture cost a
--    large-model read; since D75 the first read is the small model. Keys no code reads any more
--    (pages_per_message, max_pages: removed by D74) are dropped.
create or replace function private.triage_limits()
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'max_bytes', 15 * 1024 * 1024,
    'text_pages_per_day', 300,
    'vision_pages_per_day', 100,
    'ai_calls_per_day', 60)
$$;

-- 2. A re-read that gives a different day or time for an event this email already PUBLISHED is no
--    longer dropped in silence (D76). The published event stays as it is, and one "Different time?"
--    card asks the owner. A later re-read replaces that card (record_extraction clears undecided
--    cards), so they never stack.
do $$
declare
  f record;
  n integer := 0;
  v_old text := '      update public.event_candidates set outcome = ''duplicate'', event_id = s.id, decided_at = now(), state = ''applied'' where id = c.id;' || chr(10) || '      return ''duplicate'';';
  v_new text := '      if s.published and s.status <> ''cancelled'' and c.change_kind = ''new'' and abs(extract(epoch from (s.starts_at - c.starts_at))) >= 60 then' || chr(10)
    || '        update public.event_candidates set outcome = ''conflict'', event_id = s.id, decided_at = now(), state = ''needs_review'' where id = c.id;' || chr(10)
    || '        return ''conflict'';' || chr(10)
    || '      end if;' || chr(10)
    || '      update public.event_candidates set outcome = ''duplicate'', event_id = s.id, decided_at = now(), state = ''applied'' where id = c.id;' || chr(10) || '      return ''duplicate'';';
begin
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'private' and p.proname = 'reconcile_candidate' and p.prokind = 'f'
      and position(v_old in pg_get_functiondef(p.oid)) > 0
  loop
    execute replace(f.def, v_old, v_new);
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception 're-read conflicts: expected to change reconcile_candidate once, changed % functions', n;
  end if;
end;
$$;
