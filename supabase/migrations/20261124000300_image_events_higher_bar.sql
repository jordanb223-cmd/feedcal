-- D73: an event read from a photo, a scan or a picture-only PDF needs at least 85% to publish on
-- its own (or the feed's own bar, if that is higher). Reading a picture can misread a date, and
-- nothing later can catch it, so these get a higher bar than typed text (70%, D70).
-- The decision function is rewritten in place from its current definition.
do $$
declare
  f record;
  n integer := 0;
begin
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'private' and p.proname = 'reconcile_candidate' and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%(c.confidence >= v_threshold or %'
  loop
    execute replace(f.def, '(c.confidence >= v_threshold or ',
      '(c.confidence >= (case when c.from_transcription then greatest(v_threshold, 0.85) else v_threshold end) or ');
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception 'image bar: expected to change reconcile_candidate once, changed % functions', n;
  end if;
end;
$$;
