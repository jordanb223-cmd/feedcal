-- D77: three safeguards for publishing without the owner.
--   1. The owner is emailed as soon as an email's events are published, changed or cancelled on
--      their own, with the words each was read from, so a person sees every automatic change.
--   2. Emails are retried for 8 days, not 30 (or for ever): older mail is about dates gone by.
-- (Dropping events that are already past is done in the extraction code.)

-- ---------------------------------------------------------------- the new email kind
alter table public.notification_settings add column published_events boolean not null default true;
grant insert (published_events), update (published_events) on public.notification_settings to authenticated;

alter table private.email_outbox drop constraint email_outbox_kind_check;
alter table private.email_outbox add constraint email_outbox_kind_check check (kind in (
  'weekly_digest', 'report', 'stale_nudge', 'milestone', 'supporter_thanks', 'ops_alert', 'gmail_reconnect', 'contact', 'events_published'));

-- What one email's latest read published, changed or cancelled without the owner. Nothing is sent
-- for a message with no recorded read time (direct inserts in tests, very old rows).
create function private.notify_published(p_message_id uuid)
returns boolean
language plpgsql volatile set search_path = ''
as $$
declare
  m record;
  v_items jsonb;
begin
  select msg.feed_id, msg.original_subject, (msg.extraction ->> 'at')::timestamptz as read_at, f.owner_id, f.name
    into m from public.messages msg join public.feeds f on f.id = msg.feed_id where msg.id = p_message_id;
  if m.feed_id is null or m.read_at is null then
    return false;
  end if;
  select jsonb_agg(x.item order by x.starts_at) into v_items from (
    select distinct on (e.id) e.starts_at, jsonb_build_object(
      'event_id', e.id, 'title', e.title, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'all_day', e.all_day, 'timezone', e.timezone,
      'quote', left(e.evidence_quote, 300), 'picture', k.from_transcription,
      'what', case r.cause when 'extracted' then 'added' when 'matched_update' then 'changed' else 'cancelled' end) as item
    from public.event_candidates k
    join public.event_revisions r on r.diff ->> 'candidate' = k.id::text
    join public.events e on e.id = r.event_id
    where k.message_id = p_message_id and k.state = 'applied' and k.decided_at >= m.read_at and r.created_at >= m.read_at
      and e.published
      and ((r.cause = 'extracted' and coalesce((r.diff ->> 'published')::boolean, false)) or r.cause in ('matched_update', 'cancelled'))
    order by e.id, r.created_at desc
    limit 20) x;
  if v_items is null then
    return false;
  end if;
  return private.enqueue_email(m.owner_id, 'events_published',
    'published:' || p_message_id || ':' || to_char(m.read_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
    jsonb_build_object('feed_id', m.feed_id, 'feed_name', m.name, 'subject', left(m.original_subject, 200), 'items', v_items));
end;
$$;
revoke all on function private.notify_published(uuid) from public;

do $$
declare
  f record;
  n integer;
begin
  -- wants(): the new kind follows its own switch.
  n := 0;
  for f in select p.oid, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname = 'private' and p.proname = 'wants' and p.prokind = 'f'
             and pg_get_functiondef(p.oid) like '%when ''milestone'' then s.milestones else true end%' loop
    execute replace(f.def, 'when ''milestone'' then s.milestones else true end',
                           'when ''milestone'' then s.milestones when ''events_published'' then s.published_events else true end');
    n := n + 1;
  end loop;
  if n <> 1 then raise exception 'safeguards: wants() not changed exactly once (%)', n; end if;

  -- unsubscribe(): the link at the bottom of the new email works.
  n := 0;
  for f in select p.oid, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname = 'public' and p.proname = 'unsubscribe' and p.prokind = 'f'
             and pg_get_functiondef(p.oid) like '%''milestone'', ''supporter_thanks'', ''all'')%'
             and pg_get_functiondef(p.oid) like '%milestones = milestones and p_kind not in (''milestone'', ''all''),%' loop
    execute replace(replace(f.def, '''milestone'', ''supporter_thanks'', ''all'')', '''milestone'', ''supporter_thanks'', ''events_published'', ''all'')'),
      'milestones = milestones and p_kind not in (''milestone'', ''all''),',
      'milestones = milestones and p_kind not in (''milestone'', ''all''), published_events = published_events and p_kind not in (''events_published'', ''all''),');
    n := n + 1;
  end loop;
  if n <> 1 then raise exception 'safeguards: unsubscribe() not changed exactly once (%)', n; end if;

  -- reconcile_pending(): after an email's candidates are decided, tell the owner what was published.
  n := 0;
  for f in select p.oid, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname = 'public' and p.proname = 'reconcile_pending' and p.prokind = 'f'
             and pg_get_functiondef(p.oid) like '%    perform pgmq.delete(''reconcile_message'', j.msg_id);%' loop
    execute replace(f.def, '    perform pgmq.delete(''reconcile_message'', j.msg_id);',
      '    perform private.notify_published((j.message ->> ''message_id'')::uuid);' || chr(10) || '    perform pgmq.delete(''reconcile_message'', j.msg_id);');
    n := n + 1;
  end loop;
  if n <> 1 then raise exception 'safeguards: reconcile_pending() not changed exactly once (%)', n; end if;

  -- Retry windows: 8 days.
  n := 0;
  for f in select p.oid, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname = 'public' and p.proname = 'requeue_parked_attachments' and p.prokind = 'f'
             and pg_get_functiondef(p.oid) like '%now() - interval ''30 days''%' loop
    execute replace(f.def, 'now() - interval ''30 days''', 'now() - interval ''8 days''');
    n := n + 1;
  end loop;
  if n <> 1 then raise exception 'safeguards: requeue_parked_attachments() not changed exactly once (%)', n; end if;

  n := 0;
  for f in select p.oid, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname = 'public' and p.proname = 'requeue_waiting_extractions' and p.prokind = 'f'
             and pg_get_functiondef(p.oid) like '%and m.status = ''parsed''%' loop
    execute replace(f.def, 'and m.status = ''parsed''', 'and m.status = ''parsed'' and m.received_at > now() - interval ''8 days''');
    n := n + 1;
  end loop;
  if n <> 1 then raise exception 'safeguards: requeue_waiting_extractions() not changed exactly once (%)', n; end if;
end;
$$;
