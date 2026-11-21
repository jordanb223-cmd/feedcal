-- Phase 2: stats, operations tables, zip codes, and public_feed_page() [Rev 3, Rev 4].

-- Service-role-only tables: RLS on, no policies, no grants to anon/authenticated.

create table public.feed_fetch_daily (
  feed_id uuid not null references public.feeds (id) on delete cascade,
  day date not null,
  client_hash bytea not null check (octet_length(client_hash) = 32),  -- hash(IP + UA + daily salt), never the raw IP
  user_agent_family text check (user_agent_family is null or char_length(user_agent_family) <= 40),
  primary key (feed_id, day, client_hash)
);
alter table public.feed_fetch_daily enable row level security;
revoke all on table public.feed_fetch_daily from anon, authenticated;

-- [Rev 4] Taps on each subscribe button, a second signal next to fetch counts.
create table public.subscribe_clicks (
  feed_id uuid not null references public.feeds (id) on delete cascade,
  day date not null,
  platform text not null check (platform in ('apple', 'google', 'outlook', 'copy_link', 'other')),
  count integer not null default 0 check (count >= 0),
  primary key (feed_id, day, platform)
);
alter table public.subscribe_clicks enable row level security;
revoke all on table public.subscribe_clicks from anon, authenticated;

create table public.jobs_dedupe (
  key text primary key check (char_length(key) between 1 and 200),
  created_at timestamptz not null default now()
);
create index jobs_dedupe_created_idx on public.jobs_dedupe (created_at);
alter table public.jobs_dedupe enable row level security;
revoke all on table public.jobs_dedupe from anon, authenticated;

create table public.supporters (
  id uuid primary key default gen_random_uuid(),
  bmc_supporter_id text not null unique,
  user_id uuid references public.profiles (id) on delete set null,
  amount numeric(12, 2) not null check (amount >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);
alter table public.supporters enable row level security;
revoke all on table public.supporters from anon, authenticated;

-- Public reference data, loaded in Phase 13. Anyone can read; only the service role writes.
create table public.zip_codes (
  zip text primary key check (zip ~ '^[0-9]{5}$'),
  location extensions.geography(Point, 4326) not null,
  city text not null,
  state char(2) not null check (state ~ '^[A-Z]{2}$')
);
create index zip_codes_location_idx on public.zip_codes using gist (location);
alter table public.zip_codes enable row level security;
revoke all on table public.zip_codes from anon, authenticated;
grant select on table public.zip_codes to anon, authenticated;
create policy zip_codes_read_all on public.zip_codes for select to anon, authenticated using (true);

-- ---------------------------------------------------------------- public_feed_page [Rev 3]
-- The only way to read an unlisted feed without being its owner/editor: the exact slug.
-- Returns null for private feeds and unknown slugs. Never returns the token, intake
-- address, owner email, evidence, or unpublished events. Upcoming events only.
create function public.public_feed_page(p_slug text, p_limit integer default 50)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with f as (
    select fd.id, fd.name, fd.slug, fd.description, fd.category, fd.zip_code, fd.visibility,
           fd.last_updated_at, p.display_name as organizer_name
    from public.feeds fd
    left join public.profiles p on p.id = fd.owner_id and p.deleted_at is null
    where fd.slug = p_slug and fd.visibility in ('public', 'unlisted')
  )
  select jsonb_build_object(
    'feed', jsonb_build_object(
      'id', f.id, 'name', f.name, 'slug', f.slug, 'description', f.description,
      'category', f.category, 'zip_code', f.zip_code, 'visibility', f.visibility,
      'last_updated_at', f.last_updated_at, 'organizer_name', f.organizer_name,
      -- [Rev 4] Distinct calendar clients in the last 7 days. Google fetches once for
      -- all its users, so this is a floor: show it as "at least N".
      'subscribers_at_least', (
        select count(distinct d.client_hash) from public.feed_fetch_daily d
        where d.feed_id = f.id and d.day > current_date - 7
      )
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
revoke all on function public.public_feed_page(text, integer) from public;
grant execute on function public.public_feed_page(text, integer) to anon, authenticated;
