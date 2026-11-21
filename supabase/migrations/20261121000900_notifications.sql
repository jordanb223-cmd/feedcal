-- Phase 12: notifications and motivation (D33). Emails are queued in private.email_outbox (deduped,
-- retried) and sent every minute by the send-notifications Edge Function.

-- ---------------------------------------------------------------- subscriber estimate [Rev 4]
-- Distinct personal clients in the window, plus 1 for each calendar SERVER family seen (Google and
-- Outlook fetch once for many people, from many addresses). Shown as "at least N".
create function private.subscriber_estimate(p_feed_id uuid, p_from date, p_to date)
returns integer
language sql stable set search_path = ''
as $$
  select (select count(distinct d.client_hash) from public.feed_fetch_daily d
          where d.feed_id = p_feed_id and d.day > p_from and d.day <= p_to
            and coalesce(d.user_agent_family, 'other') not in ('google', 'outlook'))::int
       + (select count(distinct d.user_agent_family) from public.feed_fetch_daily d
          where d.feed_id = p_feed_id and d.day > p_from and d.day <= p_to
            and d.user_agent_family in ('google', 'outlook'))::int
$$;
revoke all on function private.subscriber_estimate(uuid, date, date) from public;

create or replace function public.public_feed_page(p_slug text, p_limit integer default 50)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with f as (
    select fd.id, fd.name, fd.slug, fd.description, fd.category, fd.zip_code, fd.visibility,
           fd.last_updated_at, fd.feed_token_secret_id, p.display_name as organizer_name
    from public.feeds fd
    left join public.profiles p on p.id = fd.owner_id and p.deleted_at is null
    where fd.slug = p_slug and fd.visibility in ('public', 'unlisted')
  )
  select jsonb_build_object(
    'feed', jsonb_build_object(
      'id', f.id, 'name', f.name, 'slug', f.slug, 'description', f.description,
      'category', f.category, 'zip_code', f.zip_code, 'visibility', f.visibility,
      'last_updated_at', f.last_updated_at, 'organizer_name', f.organizer_name,
      'area', (select z.city || ', ' || z.state from public.zip_codes z where z.zip = f.zip_code),
      'subscribers_at_least', private.subscriber_estimate(f.id, current_date - 7, current_date),
      -- Phase 12: no update in 90 days.
      'may_be_out_of_date', f.last_updated_at < now() - interval '90 days',
      'feed_token', (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.id = f.feed_token_secret_id)
    ),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'uid', e.uid, 'title', e.title, 'description', e.description,
        'location', e.location, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
        'all_day', e.all_day, 'timezone', e.timezone, 'rrule', e.rrule, 'status', e.status
      ) order by e.starts_at)
      from (
        select * from public.events ev
        where ev.feed_id = f.id and ev.published and ev.status <> 'cancelled'
          and coalesce(ev.ends_at, ev.starts_at) >= now()
        order by ev.starts_at
        limit least(greatest(coalesce(p_limit, 50), 1), 200)
      ) e
    ), '[]'::jsonb)
  )
  from f;
$$;

create or replace function public.feed_subscribe_stats(p_feed_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.is_feed_member(p_feed_id) then jsonb_build_object(
    'subscribers_at_least', private.subscriber_estimate(p_feed_id, current_date - 7, current_date),
    'subscribers_last_week', private.subscriber_estimate(p_feed_id, current_date - 14, current_date - 7),
    'taps_7d', coalesce((select sum(count)::int from public.subscribe_clicks where feed_id = p_feed_id and day > current_date - 7), 0),
    'clicks_30d', coalesce((select jsonb_object_agg(platform, n) from (
        select platform, sum(count)::int as n from public.subscribe_clicks
        where feed_id = p_feed_id and day > current_date - 30 group by platform) s), '{}'::jsonb)
  ) end;
$$;

-- ---------------------------------------------------------------- preferences and unsubscribe
create table public.notification_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  weekly_digest boolean not null default true,
  instant_reports boolean not null default true,
  staleness boolean not null default true,
  milestones boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.notification_settings enable row level security;
revoke all on table public.notification_settings from anon, authenticated;
grant select, insert (user_id, weekly_digest, instant_reports, staleness, milestones),
  update (weekly_digest, instant_reports, staleness, milestones, updated_at) on table public.notification_settings to authenticated;
create policy notification_settings_own on public.notification_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table private.notification_key (
  id boolean primary key default true check (id),
  key bytea not null default extensions.gen_random_bytes(32)
);
insert into private.notification_key default values;
alter table private.notification_key enable row level security;
revoke all on table private.notification_key from public, anon, authenticated;

create function private.unsubscribe_token(p_user uuid, p_kind text)
returns text
language sql stable set search_path = ''
as $$
  select encode(extensions.hmac(convert_to(p_user::text || ':' || p_kind, 'UTF8'), (select key from private.notification_key), 'sha256'), 'hex')
$$;
revoke all on function private.unsubscribe_token(uuid, text) from public;

create function private.wants(p_user uuid, p_kind text)
returns boolean
language sql stable set search_path = ''
as $$
  select coalesce((select case p_kind
      when 'weekly_digest' then s.weekly_digest when 'report' then s.instant_reports
      when 'stale_nudge' then s.staleness when 'milestone' then s.milestones else true end
    from public.notification_settings s where s.user_id = p_user), true)
$$;
revoke all on function private.wants(uuid, text) from public;

-- One-click unsubscribe from an email link (RFC 8058): the signed token is the authorisation.
create function public.unsubscribe(p_user uuid, p_kind text, p_token text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_kind not in ('weekly_digest', 'report', 'stale_nudge', 'milestone', 'all') or p_token is null
     or p_token <> private.unsubscribe_token(p_user, p_kind) then
    return false;
  end if;
  insert into public.notification_settings (user_id) values (p_user) on conflict do nothing;
  update public.notification_settings set
    weekly_digest = weekly_digest and p_kind not in ('weekly_digest', 'all'),
    instant_reports = instant_reports and p_kind not in ('report', 'all'),
    staleness = staleness and p_kind not in ('stale_nudge', 'all'),
    milestones = milestones and p_kind not in ('milestone', 'all'),
    updated_at = now()
  where user_id = p_user;
  return true;
end;
$$;
revoke all on function public.unsubscribe(uuid, text, text) from public;
grant execute on function public.unsubscribe(uuid, text, text) to anon, authenticated;

-- ---------------------------------------------------------------- outbox
create table private.email_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('weekly_digest', 'report', 'stale_nudge', 'milestone')),
  dedupe_key text not null unique,
  payload jsonb not null,
  state text not null default 'queued' check (state in ('queued', 'sent', 'failed')),
  attempts smallint not null default 0,
  last_error text,
  provider_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index email_outbox_queued_idx on private.email_outbox (created_at) where state = 'queued';
alter table private.email_outbox enable row level security;
revoke all on table private.email_outbox from public, anon, authenticated;

create function private.enqueue_email(p_user uuid, p_kind text, p_dedupe text, p_payload jsonb)
returns boolean
language plpgsql volatile set search_path = ''
as $$
begin
  if not private.wants(p_user, p_kind) then
    return false;
  end if;
  insert into private.email_outbox (user_id, kind, dedupe_key, payload) values (p_user, p_kind, p_dedupe, p_payload)
  on conflict (dedupe_key) do nothing;
  return found;
end;
$$;
revoke all on function private.enqueue_email(uuid, text, text, jsonb) from public;

-- The sender claims queued mail with the recipient's address and the unsubscribe token.
create function public.claim_outbox(p_limit integer default 20)
returns table (id uuid, kind text, payload jsonb, email text, user_id uuid, unsubscribe_token text)
language sql volatile security definer set search_path = ''
as $$
  update private.email_outbox o set attempts = o.attempts + 1
  from auth.users u
  where o.id in (select x.id from private.email_outbox x where x.state = 'queued' and x.attempts < 5
                 order by x.created_at limit least(greatest(p_limit, 1), 100) for update skip locked)
    and u.id = o.user_id
  returning o.id, o.kind, o.payload, u.email, o.user_id, private.unsubscribe_token(o.user_id, o.kind)
$$;

create function public.mark_outbox(p_id uuid, p_sent boolean, p_provider_id text default null, p_error text default null)
returns void
language sql volatile security definer set search_path = ''
as $$
  update private.email_outbox set
    state = case when p_sent then 'sent' when attempts >= 5 then 'failed' else 'queued' end,
    sent_at = case when p_sent then now() end, provider_id = left(p_provider_id, 200), last_error = left(p_error, 500)
  where id = p_id
$$;
revoke all on function public.claim_outbox(integer), public.mark_outbox(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.claim_outbox(integer), public.mark_outbox(uuid, boolean, text, text) to service_role;

-- ---------------------------------------------------------------- subscriber reports (instant notice)
create table private.report_limits (
  reporter_hash bytea not null,
  at timestamptz not null default now()
);
create index report_limits_idx on private.report_limits (reporter_hash, at);
alter table private.report_limits enable row level security;
revoke all on table private.report_limits from public, anon, authenticated;

-- Anyone with the calendar can report a problem with an event (the link is in every event's
-- description). 10 reports an hour per network; the IP is stored only as a salted hash.
create function public.submit_report(p_event_uid text, p_kind text, p_details text default null, p_client_ip text default null)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_hash bytea;
  v_report uuid;
  m record;
begin
  if p_kind not in ('wrong_details', 'missing_event', 'spam', 'abuse', 'other') then
    return 'bad_kind';
  end if;
  select * into e from public.events where uid = left(p_event_uid, 200) and published;
  if not found then
    return 'not_found';
  end if;
  if p_client_ip is not null then
    v_hash := extensions.digest((select key from private.notification_key) || convert_to(left(p_client_ip, 64), 'UTF8'), 'sha256');
    delete from private.report_limits where at < now() - interval '1 hour';
    if (select count(*) from private.report_limits where reporter_hash = v_hash) >= 10 then
      return 'rate_limited';
    end if;
    insert into private.report_limits (reporter_hash) values (v_hash);
  end if;
  insert into public.reports (feed_id, event_id, kind, details, reporter_hash)
  values (e.feed_id, e.id, p_kind, nullif(left(trim(p_details), 2000), ''), v_hash)
  returning id into v_report;
  for m in select fe.user_id from public.feed_editors fe where fe.feed_id = e.feed_id loop
    perform private.enqueue_email(m.user_id, 'report', 'report:' || v_report || ':' || m.user_id,
      jsonb_build_object('feed_id', e.feed_id, 'feed_name', (select name from public.feeds where id = e.feed_id),
                         'event_id', e.id, 'event_title', e.title, 'starts_at', e.starts_at, 'all_day', e.all_day,
                         'timezone', e.timezone, 'kind', p_kind, 'details', nullif(left(trim(p_details), 2000), '')));
  end loop;
  return 'ok';
end;
$$;
revoke all on function public.submit_report(text, text, text, text) from public;
grant execute on function public.submit_report(text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------- weekly digest
create function private.digest_payload(p_user uuid)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object('feeds', coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'name', f.name,
      'subscribers', private.subscriber_estimate(f.id, current_date - 7, current_date),
      'subscribers_last_week', private.subscriber_estimate(f.id, current_date - 14, current_date - 7),
      'taps', coalesce((select sum(count)::int from public.subscribe_clicks c where c.feed_id = f.id and c.day > current_date - 7), 0),
      'events_added', (select count(*)::int from public.events e where e.feed_id = f.id and e.published and e.created_at > now() - interval '7 days'),
      'needs_review', (select count(*)::int from public.event_candidates c where c.feed_id = f.id and c.state = 'needs_review')
                    + (select count(*)::int from public.events e where e.feed_id = f.id and not e.published and e.status = 'tentative'),
      'reports', (select count(*)::int from public.reports r where r.feed_id = f.id and r.created_at > now() - interval '7 days')
    ) order by f.name), '[]'::jsonb))
  from public.feeds f join public.feed_editors fe on fe.feed_id = f.id
  where fe.user_id = p_user and f.delete_requested_at is null
$$;
revoke all on function private.digest_payload(uuid) from public;

create function private.queue_weekly_digests()
returns integer
language plpgsql volatile set search_path = ''
as $$
declare
  u record;
  v integer := 0;
begin
  for u in select distinct fe.user_id from public.feed_editors fe join public.profiles p on p.id = fe.user_id where p.deleted_at is null loop
    if private.enqueue_email(u.user_id, 'weekly_digest', 'digest:' || u.user_id || ':' || to_char(current_date, 'IYYY-IW'), private.digest_payload(u.user_id)) then
      v := v + 1;
    end if;
  end loop;
  return v;
end;
$$;
revoke all on function private.queue_weekly_digests() from public;

-- ---------------------------------------------------------------- staleness and milestones
alter table public.feeds add column stale_nudged_at timestamptz;

create table public.feed_milestones (
  feed_id uuid not null references public.feeds (id) on delete cascade,
  milestone integer not null check (milestone in (10, 50, 100)),
  reached_at timestamptz not null default now(),
  primary key (feed_id, milestone)
);
alter table public.feed_milestones enable row level security;
revoke all on table public.feed_milestones from anon, authenticated;
grant select on table public.feed_milestones to authenticated;
create policy feed_milestones_member_select on public.feed_milestones for select to authenticated using (private.is_feed_member(feed_id));

-- Daily: nudge owners of quiet feeds (no update in 45 days, nothing coming up), once per quiet
-- spell; record milestones (10, 50, 100) and send a thank-you. No streaks, ever.
create function private.daily_motivation()
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  f record;
  v_n integer;
  v_m integer;
  v_nudges integer := 0;
  v_milestones integer := 0;
begin
  for f in select fd.* from public.feeds fd
           where fd.delete_requested_at is null and fd.last_updated_at < now() - interval '45 days'
             and (fd.stale_nudged_at is null or fd.stale_nudged_at < fd.last_updated_at)
             and not exists (select 1 from public.events e where e.feed_id = fd.id and e.published and e.status <> 'cancelled' and e.starts_at > now()) loop
    perform private.enqueue_email(f.owner_id, 'stale_nudge', 'stale:' || f.id || ':' || f.last_updated_at::date,
      jsonb_build_object('feed_id', f.id, 'feed_name', f.name, 'last_updated_at', f.last_updated_at,
                         'days', extract(day from now() - f.last_updated_at)::int));
    update public.feeds set stale_nudged_at = now() where id = f.id;
    v_nudges := v_nudges + 1;
  end loop;

  for f in select fd.id, fd.name, fd.owner_id from public.feeds fd where fd.delete_requested_at is null loop
    v_n := private.subscriber_estimate(f.id, current_date - 7, current_date);
    foreach v_m in array array[10, 50, 100] loop
      if v_n >= v_m then
        insert into public.feed_milestones (feed_id, milestone) values (f.id, v_m) on conflict do nothing;
        if found then
          perform private.enqueue_email(f.owner_id, 'milestone', 'milestone:' || f.id || ':' || v_m,
            jsonb_build_object('feed_id', f.id, 'feed_name', f.name, 'milestone', v_m));
          v_milestones := v_milestones + 1;
        end if;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('nudges', v_nudges, 'milestones', v_milestones);
end;
$$;
revoke all on function private.daily_motivation() from public;

select cron.schedule('feedcal-weekly-digest', '0 15 * * 1', $$ select private.queue_weekly_digests() $$);  -- Mondays 15:00 UTC (7-8 AM Pacific)
select cron.schedule('feedcal-daily-motivation', '30 16 * * *', $$ select private.daily_motivation() $$);
select cron.schedule('feedcal-send-notifications', '* * * * *', $$ select private.call_edge_function('send-notifications') $$);

-- For tests and operators: queue this week's digests now (the schedule does it on Mondays).
create function public.run_weekly_digests()
returns integer
language sql volatile security definer set search_path = ''
as $$ select private.queue_weekly_digests() $$;
revoke all on function public.run_weekly_digests() from public, anon, authenticated;
grant execute on function public.run_weekly_digests() to service_role;
