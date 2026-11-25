-- D86 (owner's decision): when a Gmail connection has lapsed and the organizer has not reconnected,
--   * the organizer is reminded every 20 days for as long as it stays lapsed, and
--   * after 20 days the calendar's public page and calendar file say so to followers.
-- "Lapsed" starts when Google refuses the connection (status becomes needs_reconnect).
alter table private.gmail_connections
  add column lapsed_at timestamptz,
  add column lapse_reminders integer not null default 0 check (lapse_reminders >= 0);

-- Connections already lapsed: count from the last time a check worked, or from connecting.
update private.gmail_connections set lapsed_at = coalesce(last_checked_at, connected_at)
where status = 'needs_reconnect' and lapsed_at is null;

-- The day a calendar's Gmail connection lapsed, once that is 20 days or more ago; otherwise null.
create function private.gmail_lapsed_since(p_feed_id uuid)
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select g.lapsed_at from private.gmail_connections g
  where g.feed_id = p_feed_id and g.status = 'needs_reconnect' and g.lapsed_at <= now() - interval '20 days';
$$;
revoke all on function private.gmail_lapsed_since(uuid) from public;

-- The functions that mark, clear and report a lapse are rewritten in place from their current
-- definitions, so nothing else in them changes. Each change must land exactly where expected.
do $$
declare
  f record;
  n integer;
  edits text[][] := array[
    -- Google refuses the token: remember when (only the first time).
    array['status = case when p_reconnect then ''needs_reconnect'' else status end',
          'lapsed_at = case when p_reconnect then coalesce(lapsed_at, now()) else lapsed_at end, status = case when p_reconnect then ''needs_reconnect'' else status end'],
    -- The organizer reconnects: the lapse is over.
    array['connected_at = now(), reminded_at = null, last_error = null,',
          'connected_at = now(), reminded_at = null, last_error = null, lapsed_at = null, lapse_reminders = 0,'],
    -- The public page learns of a lapse of 20 days or more.
    array['''may_be_out_of_date'', f.last_updated_at < now() - interval ''90 days'',',
          '''may_be_out_of_date'', f.last_updated_at < now() - interval ''90 days'', ''source_lapsed_since'', private.gmail_lapsed_since(f.id),'],
    -- So does the calendar file.
    array['''slug'', v_feed.slug, ''description'', v_feed.description,',
          '''slug'', v_feed.slug, ''description'', v_feed.description, ''source_lapsed_since'', private.gmail_lapsed_since(v_feed.id),']
  ];
  i integer;
begin
  for i in 1 .. array_length(edits, 1) loop
    n := 0;
    for f in
      select p.oid, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname in ('public', 'private') and p.prokind = 'f'
        and position(edits[i][1] in pg_get_functiondef(p.oid)) > 0
    loop
      execute replace(f.def, edits[i][1], edits[i][2]);
      n := n + 1;
    end loop;
    if n <> 1 then
      raise exception 'gmail lapse: edit % expected to change one function, changed %', i, n;
    end if;
  end loop;
end;
$$;

-- Reminders: the day before the 7-day limit (as before), and every 20 days while lapsed.
create or replace function private.gmail_reminders()
returns integer
language plpgsql volatile set search_path = ''
as $$
declare
  n integer := 0;
  c record;
begin
  for c in select g.*, f.name from private.gmail_connections g join public.feeds f on f.id = g.feed_id
           where g.status = 'active' and g.reminded_at is null and g.connected_at < now() - interval '6 days' loop
    perform private.enqueue_email(c.user_id, 'gmail_reconnect', 'gmail_reconnect:' || c.feed_id || ':' || to_char(c.connected_at, 'YYYYMMDDHH24MISS'),
      jsonb_build_object('feed_id', c.feed_id, 'feed_name', c.name, 'expired', false));
    update private.gmail_connections set reminded_at = now() where feed_id = c.feed_id;
    n := n + 1;
  end loop;
  -- One reminder per 20-day mark. A connection found long lapsed gets one now, not one per mark missed.
  for c in select g.*, f.name, floor(extract(epoch from (now() - g.lapsed_at)) / (20 * 86400))::integer as marks
           from private.gmail_connections g join public.feeds f on f.id = g.feed_id
           where g.status = 'needs_reconnect' and g.lapsed_at is not null
             and now() >= g.lapsed_at + make_interval(days => 20 * (g.lapse_reminders + 1)) loop
    perform private.enqueue_email(c.user_id, 'gmail_reconnect', 'gmail_lapsed:' || c.feed_id || ':' || to_char(c.lapsed_at, 'YYYYMMDDHH24MISS') || ':' || c.marks,
      jsonb_build_object('feed_id', c.feed_id, 'feed_name', c.name, 'expired', true, 'days_lapsed', c.marks * 20));
    update private.gmail_connections set lapse_reminders = c.marks where feed_id = c.feed_id;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function private.gmail_reminders() from public;
