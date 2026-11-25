-- D87 (owner's design): a public status page for every calendar, linked from each event, so
-- followers can see for themselves how current the calendar is. This returns only what that page
-- shows: no sender address, no email subject, nothing about followers, and for a private
-- calendar no name.
create function public.feed_status(p_feed_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    -- A private calendar's name and organizer are not given to someone who only has its id.
    -- Its followers reach this page from their own events and know which calendar it is.
    'name', case when f.visibility in ('public', 'unlisted') then f.name end,
    'organizer_name', case when f.visibility in ('public', 'unlisted') then p.display_name end,
    -- Only calendars with a public page get a link back to it.
    'slug', case when f.visibility in ('public', 'unlisted') then f.slug end,
    'last_updated_at', f.last_updated_at,
    'last_email_at', (select max(m.received_at) from public.messages m where m.feed_id = f.id),
    'upcoming', (select count(*)::int from public.events e
                 where e.feed_id = f.id and e.published and e.status <> 'cancelled'
                   and private.next_start(e.starts_at, e.ends_at, e.occurrences) is not null),
    'gmail', (select jsonb_build_object(
                'state', case when g.status = 'needs_reconnect' then 'disconnected' else 'working' end,
                'last_checked_at', g.last_checked_at,
                'next_check_at', case when g.status = 'active' then g.next_check_at end,
                'disconnected_since', case when g.status = 'needs_reconnect' then g.lapsed_at end,
                'renewed_at', g.connected_at)
              from private.gmail_connections g
              where g.feed_id = f.id and g.status in ('active', 'needs_reconnect'))
  )
  from public.feeds f
  left join public.profiles p on p.id = f.owner_id and p.deleted_at is null
  where f.id = p_feed_id and f.hidden_at is null and f.delete_requested_at is null;
$$;
revoke all on function public.feed_status(uuid) from public;
grant execute on function public.feed_status(uuid) to anon, authenticated;
