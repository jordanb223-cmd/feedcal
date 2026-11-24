-- D74: no page limit per email. The size rule (15 MB) lives in triage; here the database stops
-- assuming "at most 5 pages", and emails that lost files to the old limit go back through.

alter table public.messages drop constraint messages_pages_for_ai_check;
alter table public.messages add constraint messages_pages_for_ai_check check (pages_for_ai is null or pages_for_ai >= 0);

-- record_triage capped the count at 5 and counted only the files in this pass. A retry can now
-- leave already-read files alone (D71), so count every page the email has.
do $$
declare
  f record;
  n integer := 0;
begin
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'record_triage' and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%pages_for_ai = least(v_pages, 5)%'
  loop
    execute replace(f.def, 'pages_for_ai = least(v_pages, 5)',
      'pages_for_ai = least((select count(*) from public.attachment_pages ap join public.attachments aa on aa.id = ap.attachment_id where aa.message_id = p_message_id), 30000)');
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception 'no page limit: expected to change record_triage once, changed % functions', n;
  end if;
end;
$$;

-- As D71's version, plus: files skipped only because of the old limits (5 pages per email, 40 pages per file).
create or replace function public.requeue_parked_attachments(p_limit integer default 5)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select m.id from public.messages m
    where m.received_at > now() - interval '30 days'
      and exists (
        select 1 from public.attachments a
        where a.message_id = m.id
          and ((a.status = 'pending' and a.triage ->> 'reason' = 'needs_vision_not_configured')
            or (a.status = 'pending' and a.triage ->> 'reason' = 'daily_vision_limit' and a.triaged_at < date_trunc('day', now()))
            or (a.status = 'skipped' and a.triage ->> 'reason' in ('page_budget_used', 'too_many_pages'))))
      and not exists (select 1 from pgmq.q_triage_message q where q.message ->> 'message_id' = m.id::text)
    order by m.received_at desc
    limit least(greatest(coalesce(p_limit, 5), 1), 50)
  loop
    perform pgmq.send('triage_message', jsonb_build_object('message_id', v_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
