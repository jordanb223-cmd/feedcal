-- D48 (2026-11-21, owner's request).
--  1. Follower count: "at least N" must never overstate. Client codes are salted per day, so the
--     same phone counted once per day it checked, and non-calendar fetches (monitors, scripts)
--     counted too. Now: calendar apps only, and the busiest single day in the window.
--  2. Organizers can import a calendar link (.ics) into their own calendar, as a tucked-away
--     option. Default: a one-time copy the organizer then owns (self-hosted). Optional: keep
--     checking the link daily.

-- ---------------------------------------------------------------- 1. follower count
create or replace function private.subscriber_estimate(p_feed_id uuid, p_from date, p_to date)
returns integer
language sql stable set search_path = ''
as $$
  -- Per day: each distinct Apple client, plus 1 for each calendar SERVER family seen (Google and
  -- Outlook fetch once for many people). "other" (unknown apps, monitors, scripts) isn't counted.
  select coalesce(max(n), 0)::int from (
    select d.day,
           count(distinct d.client_hash) filter (where d.user_agent_family = 'apple')
         + count(distinct d.user_agent_family) filter (where d.user_agent_family in ('google', 'outlook')) as n
    from public.feed_fetch_daily d
    where d.feed_id = p_feed_id and d.day > p_from and d.day <= p_to
    group by d.day
  ) per_day
$$;
revoke all on function private.subscriber_estimate(uuid, date, date) from public;

create or replace function public.feed_subscribe_stats(p_feed_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.is_feed_member(p_feed_id) then jsonb_build_object(
    'subscribers_at_least', private.subscriber_estimate(p_feed_id, current_date - 7, current_date),
    'clicks_30d', coalesce((select jsonb_object_agg(platform, n) from (
        select platform, sum(count)::int as n from public.subscribe_clicks
        where feed_id = p_feed_id and day > current_date - 30 group by platform) s), '{}'::jsonb)
  ) end;
$$;

-- ---------------------------------------------------------------- 2. organizer imports
alter table public.feeds add column import_mode text not null default 'daily' check (import_mode in ('once', 'daily'));

create or replace function private.rate_limits()
returns jsonb
language sql immutable set search_path = ''
as $$ select '{
  "feed_miss":   {"max": 30,  "seconds": 600},
  "search":      {"max": 60,  "seconds": 60},
  "click":       {"max": 30,  "seconds": 60},
  "import":      {"max": 10,  "seconds": 86400}
}'::jsonb $$;

-- Owner only. The URL is checked again (hosts, redirects, size) where it's fetched.
create function public.feed_import_set(p_feed_id uuid, p_url text, p_keep_updating boolean default false)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
begin
  perform private.assert_feed_owner(p_feed_id);
  if v_url ~* '^webcal://' then v_url := 'https://' || substr(v_url, 10); end if;
  if char_length(v_url) > 2000 or v_url !~* '^https://[a-z0-9.-]+\.[a-z]{2,63}(:[0-9]{2,5})?(/[^\s]*)?$' then
    return 'bad_url';
  end if;
  if not private.rate_ok('import', auth.uid()::text) then
    return 'too_many';
  end if;
  update public.feeds set import_url = v_url, import_mode = case when p_keep_updating then 'daily' else 'once' end,
    imported_at = null
  where id = p_feed_id;
  return 'ok';
end;
$$;

create function public.feed_import_stop(p_feed_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.assert_feed_owner(p_feed_id);
  update public.feeds set import_url = null where id = p_feed_id;  -- events already copied stay
  return found;
end;
$$;

create function public.feed_import_status(p_feed_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.is_feed_member(p_feed_id) then (
    select jsonb_build_object('url', f.import_url, 'mode', f.import_mode, 'imported_at', f.imported_at,
      'events', (select count(*) from public.events e where e.feed_id = f.id and e.external_uid is not null and e.status <> 'cancelled'))
    from public.feeds f where f.id = p_feed_id) end
$$;

revoke all on function public.feed_import_set(uuid, text, boolean), public.feed_import_stop(uuid), public.feed_import_status(uuid) from public, anon;
grant execute on function public.feed_import_set(uuid, text, boolean), public.feed_import_stop(uuid), public.feed_import_status(uuid) to authenticated;

-- A one-time copy ends after its first successful import: the link is forgotten, the events stay.
create or replace function public.record_import(p_feed_id uuid, p_events jsonb)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e jsonb;
  v integer := 0;
begin
  if not exists (select 1 from public.feeds where id = p_feed_id and import_url is not null) then
    return 0;
  end if;
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) limit 2000 loop
    insert into public.events (feed_id, external_uid, title, description, location, starts_at, ends_at, all_day, timezone, rrule, status, published)
    values (p_feed_id, left(e ->> 'uid', 500), left(coalesce(nullif(e ->> 'title', ''), 'Event'), 300), left(e ->> 'description', 8000),
            left(e ->> 'location', 500), (e ->> 'starts_at')::timestamptz, (e ->> 'ends_at')::timestamptz,
            coalesce((e ->> 'all_day')::boolean, false), coalesce(e ->> 'timezone', 'America/Los_Angeles'), left(e ->> 'rrule', 500),
            case when e ->> 'status' = 'cancelled' then 'cancelled' else 'confirmed' end, true)
    on conflict (feed_id, external_uid) where external_uid is not null do update set
      title = excluded.title, description = excluded.description, location = excluded.location, starts_at = excluded.starts_at,
      ends_at = excluded.ends_at, all_day = excluded.all_day, timezone = excluded.timezone, rrule = excluded.rrule,
      status = case when public.events.status = 'cancelled' and excluded.status = 'confirmed' then 'confirmed' else excluded.status end;
    v := v + 1;
  end loop;
  update public.events set status = 'cancelled'
    where feed_id = p_feed_id and external_uid is not null and status <> 'cancelled'
      and not (external_uid = any(select x ->> 'uid' from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) x));
  update public.feeds set import_url = null where id = p_feed_id and import_mode = 'once';
  return v;
end;
$$;

-- Check every 10 minutes so a new import runs soon; claim_imports still takes each link at most
-- once per 20 hours, so daily links are fetched daily.
select cron.unschedule('feedcal-import-feeds');
select cron.schedule('feedcal-import-feeds', '*/10 * * * *', $$ select private.call_edge_function('import-feeds') $$);
