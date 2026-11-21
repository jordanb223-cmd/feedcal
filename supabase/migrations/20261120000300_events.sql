-- Phase 2: events, event_revisions, reports.

-- ---------------------------------------------------------------- events
create table public.events (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  uid text generated always as (id::text || '@feedcal.app') stored,
  title text not null check (char_length(title) between 1 and 300),
  description text check (description is null or char_length(description) <= 8000),
  location text check (location is null or char_length(location) <= 500),
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  timezone text not null default 'America/Los_Angeles',
  rrule text check (rrule is null or char_length(rrule) <= 500),
  status text not null default 'confirmed' check (status in ('tentative', 'confirmed', 'cancelled')),
  sequence integer not null default 0 check (sequence >= 0),
  confidence numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  source_message_id uuid references public.messages (id) on delete set null,
  evidence_quote text check (evidence_quote is null or char_length(evidence_quote) <= 2000),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);
create unique index events_uid_idx on public.events (uid);
create index events_feed_starts_idx on public.events (feed_id, starts_at);
create index events_source_message_idx on public.events (source_message_id);
alter table public.events enable row level security;

-- Timezone must be a real IANA name. A trigger, not a CHECK, because the lookup isn't immutable.
create function private.events_before_write()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone: %', new.timezone using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;
create trigger events_before_write before insert or update on public.events
  for each row execute function private.events_before_write();

-- Any event change marks the feed as freshly updated (directory "freshness", Phase 13).
create function private.events_touch_feed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.feeds set last_updated_at = now()
    where id = coalesce(new.feed_id, old.feed_id);
  return null;
end;
$$;
create trigger events_touch_feed after insert or update or delete on public.events
  for each row execute function private.events_touch_feed();
revoke all on function private.events_before_write(), private.events_touch_feed() from public;

-- Anon reads published events of public feeds, public-safe columns only. Signed-in
-- non-members read public pages through public_feed_page(), not this table, so the
-- evidence quote and confidence are never exposed outside the feed's owners/editors.
revoke all on table public.events from anon, authenticated;
grant select (id, feed_id, uid, title, description, location, starts_at, ends_at, all_day, timezone,
  rrule, status, sequence, created_at, updated_at) on table public.events to anon;
grant select, delete on table public.events to authenticated;
grant insert (feed_id, title, description, location, starts_at, ends_at, all_day, timezone, rrule,
  status, sequence, confidence, source_message_id, evidence_quote, published) on table public.events to authenticated;
grant update (title, description, location, starts_at, ends_at, all_day, timezone, rrule,
  status, sequence, published) on table public.events to authenticated;

create policy events_anon_select_public on public.events
  for select to anon using (published and private.feed_is_public(feed_id));
create policy events_member_select on public.events
  for select to authenticated using (private.is_feed_member(feed_id));
create policy events_member_insert on public.events
  for insert to authenticated with check (private.is_feed_member(feed_id));
create policy events_member_update on public.events
  for update to authenticated using (private.is_feed_member(feed_id)) with check (private.is_feed_member(feed_id));
create policy events_member_delete on public.events
  for delete to authenticated using (private.is_feed_member(feed_id));

-- ---------------------------------------------------------------- event_revisions
create table public.event_revisions (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events (id) on delete cascade,
  sequence integer not null check (sequence >= 0),
  diff jsonb not null,
  cause text not null check (cause in ('extracted', 'matched_update', 'manual_edit', 'cancelled', 'restored')),
  actor text not null check (actor ~ '^(ai|system|user:[0-9a-f-]{36})$'),
  created_at timestamptz not null default now()
);
create index event_revisions_event_idx on public.event_revisions (event_id, sequence);
alter table public.event_revisions enable row level security;
revoke all on table public.event_revisions from anon, authenticated;
grant select on table public.event_revisions to authenticated;

create function private.event_feed_id(p_event_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$ select e.feed_id from public.events e where e.id = p_event_id; $$;
revoke all on function private.event_feed_id(uuid) from public;
grant execute on function private.event_feed_id(uuid) to authenticated, service_role;

create policy event_revisions_member_select on public.event_revisions
  for select to authenticated using (private.is_feed_member(private.event_feed_id(event_id)));

-- ---------------------------------------------------------------- reports
-- Subscriber "Report a problem" (Phase 12/14). Inserted server-side with rate limits;
-- owners/editors read them and change status.
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  event_id uuid references public.events (id) on delete set null,
  kind text not null check (kind in ('wrong_details', 'missing_event', 'spam', 'abuse', 'other')),
  details text check (details is null or char_length(details) <= 2000),
  reporter_hash bytea check (reporter_hash is null or octet_length(reporter_hash) = 32),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now()
);
create index reports_feed_idx on public.reports (feed_id, created_at desc);
alter table public.reports enable row level security;
revoke all on table public.reports from anon, authenticated;
grant select on table public.reports to authenticated;
grant update (status) on table public.reports to authenticated;

create policy reports_member_select on public.reports
  for select to authenticated using (private.is_feed_member(feed_id));
create policy reports_member_update on public.reports
  for update to authenticated using (private.is_feed_member(feed_id)) with check (private.is_feed_member(feed_id));
