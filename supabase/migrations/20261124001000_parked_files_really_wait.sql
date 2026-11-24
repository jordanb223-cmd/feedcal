-- D80: a file that a retry parks is really marked as waiting.
--
-- record_triage did not change an attachment's status when the new result was "pending" and a
-- direct move to pending was allowed: the row kept its old status ("skipped") with the new reason
-- ("daily_vision_limit"). The Email page showed "waiting", but requeue_parked_attachments looks for
-- status "pending", so such a file was never retried. Seen on production: two Room F photos first
-- found blank, then parked on the daily limit, stayed "skipped".

do $$
declare
  f record;
  n integer := 0;
  v_old text := '      if (r ->> ''status'') <> ''pending'' then' || chr(10)
    || '        update public.attachments set status = r ->> ''status'' where id = (r ->> ''id'')::uuid;' || chr(10)
    || '      end if;';
  v_new text := '      update public.attachments set status = r ->> ''status''' || chr(10)
    || '        where id = (r ->> ''id'')::uuid and status is distinct from (r ->> ''status'');';
begin
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'record_triage' and p.prokind = 'f'
      and position(v_old in pg_get_functiondef(p.oid)) > 0
  loop
    execute replace(f.def, v_old, v_new);
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception 'parked status: expected to change record_triage once, changed % functions', n;
  end if;
end;
$$;

-- Rows already left in that state: give them the status their reason describes, so they are retried.
update public.attachments set status = 'pending'
  where status = 'skipped' and triage ->> 'reason' in ('daily_vision_limit', 'needs_vision_not_configured');
