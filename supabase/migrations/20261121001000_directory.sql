-- Phase 13: the public directory (D34). Only visibility = 'public' feeds ever appear; unlisted and
-- private feeds never do (search, near, sitemap). Search runs as SECURITY INVOKER through the anon
-- role, so RLS and anon's column grants decide what it can see.

-- The Census ZCTA gazetteer has a point per ZIP but no city or state.
alter table public.zip_codes alter column city drop not null, alter column state drop not null;

alter table public.feeds
  add column verified boolean not null default false,                 -- Phase 14 sets it
  add column imported_source_name text check (imported_source_name is null or char_length(imported_source_name) <= 120),
  add column import_url text check (import_url is null or (import_url ~ '^https://\S+$' and char_length(import_url) <= 1000)),
  add column imported_at timestamptz;
grant select (verified, imported_source_name) on table public.feeds to anon, authenticated;
-- import_url stays server-side only (never granted).

alter table public.events add column external_uid text check (external_uid is null or char_length(external_uid) <= 500);
create unique index events_feed_external_uid_idx on public.events (feed_id, external_uid) where external_uid is not null;

-- A feed's map point follows its ZIP code.
create function private.feeds_set_location()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.zip_code is not null and (tg_op = 'INSERT' or new.zip_code is distinct from old.zip_code) then
    new.location := (select z.location from public.zip_codes z where z.zip = new.zip_code);
  elsif new.zip_code is null then
    new.location := null;
  end if;
  return new;
end;
$$;
revoke all on function private.feeds_set_location() from public;
create trigger feeds_set_location before insert or update of zip_code on public.feeds
  for each row execute function private.feeds_set_location();
update public.feeds f set location = z.location from public.zip_codes z where z.zip = f.zip_code and f.location is null;

-- Follower estimate for PUBLIC feeds only, so the directory can rank by it without seeing fetch rows.
create function private.public_subscribers(p_feed_id uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select case when exists (select 1 from public.feeds where id = p_feed_id and visibility = 'public')
    then private.subscriber_estimate(p_feed_id, current_date - 7, current_date) else 0 end
$$;
revoke all on function private.public_subscribers(uuid) from public;
grant execute on function private.public_subscribers(uuid) to anon, authenticated;

create function public.directory_search(p_query text default null, p_zip text default null, p_miles integer default 10,
                                        p_category text default null, p_limit integer default 30)
returns table (slug text, name text, description text, category text, zip_code text, city text, state text,
               distance_miles numeric, subscribers integer, last_updated_at timestamptz, may_be_out_of_date boolean,
               verified boolean, imported_source_name text, score numeric)
language sql stable security invoker set search_path = ''
as $$
  with origin as (select z.location from public.zip_codes z where z.zip = p_zip),
  q as (select nullif(trim(left(p_query, 200)), '') as text),
  hits as (
    -- Only columns anon is granted (never select *: intake addresses and token hashes are off limits).
    select f.id, f.slug, f.name, f.description, f.category, f.zip_code, f.location, f.search, f.last_updated_at,
      f.verified, f.imported_source_name, z.city, z.state,
      case when (select location from origin) is not null and f.location is not null
           then extensions.st_distance(f.location, (select location from origin)) / 1609.344 end as miles,
      case when (select text from q) is null then 0
           else pg_catalog.ts_rank(f.search, websearch_to_tsquery('english', (select text from q))) end as rank,
      case when (select text from q) is null then 0
           -- word_similarity: how well the query matches the best part of the text, so typos
           -- in a short query still hit a long name ("socer" → 0.63, "pizza" → 0.17).
           else extensions.word_similarity(lower((select text from q)), lower(f.name || ' ' || coalesce(z.city, '') || ' ' || coalesce(f.category, ''))) end as sim
    from public.feeds f
    left join public.zip_codes z on z.zip = f.zip_code
    where f.visibility = 'public'
      and (p_category is null or f.category = p_category)
      and (p_zip is null or ((select location from origin) is not null and f.location is not null
           and extensions.st_dwithin(f.location, (select location from origin), least(greatest(coalesce(p_miles, 10), 1), 50) * 1609.344)))
  )
  select h.slug, h.name, h.description, h.category, h.zip_code, h.city, h.state,
    round(h.miles::numeric, 1), private.public_subscribers(h.id), h.last_updated_at,
    h.last_updated_at < now() - interval '90 days', h.verified, h.imported_source_name,
    round((3 * h.rank + 2 * h.sim
      + case when h.miles is null then 0 else 2 * greatest(0, 1 - h.miles / least(greatest(coalesce(p_miles, 10), 1), 50)) end
      + 0.5 * ln(1 + private.public_subscribers(h.id))
      + case when h.last_updated_at > now() - interval '30 days' then 1 when h.last_updated_at < now() - interval '90 days' then -2 else 0 end
      + case when h.verified then 0.5 else 0 end)::numeric, 3)
  from hits h
  where (select text from q) is null
     or h.search @@ websearch_to_tsquery('english', (select text from q))
     or h.sim > 0.45
  order by 14 desc, h.name
  limit least(greatest(coalesce(p_limit, 30), 1), 100)
$$;
revoke all on function public.directory_search(text, text, integer, text, integer) from public;
grant execute on function public.directory_search(text, text, integer, text, integer) to anon, authenticated;

-- ---------------------------------------------------------------- imported calendars
-- Public calendars Feedcal re-publishes (e.g. a library's own .ics), re-fetched daily and labelled
-- with their source. Added by an operator, never by users.
create function public.add_imported_feed(p_name text, p_url text, p_source_name text, p_category text, p_zip text, p_owner uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.feeds (owner_id, name, slug, category, zip_code, visibility, imported_source_name, import_url)
  values (p_owner, left(p_name, 120),
          left(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), 60) || '-imported',
          p_category, p_zip, 'public', left(p_source_name, 120), p_url)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.claim_imports(p_limit integer default 20)
returns table (feed_id uuid, url text, timezone text)
language sql volatile security definer set search_path = ''
as $$
  update public.feeds f set imported_at = now()
  where f.id in (select id from public.feeds where import_url is not null and delete_requested_at is null
                   and (imported_at is null or imported_at < now() - interval '20 hours')
                 order by imported_at nulls first limit least(greatest(p_limit, 1), 100))
  returning f.id, f.import_url, f.timezone
$$;

-- Replace an imported feed's events with what the source publishes now. Events that vanished
-- from the source are cancelled (kept 30 days so calendars remove them), never deleted.
create function public.record_import(p_feed_id uuid, p_events jsonb)
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
  return v;
end;
$$;
revoke all on function public.add_imported_feed(text, text, text, text, text, uuid), public.claim_imports(integer), public.record_import(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.add_imported_feed(text, text, text, text, text, uuid), public.claim_imports(integer), public.record_import(uuid, jsonb)
  to service_role;

select cron.schedule('feedcal-import-feeds', '0 13 * * *', $$ select private.call_edge_function('import-feeds') $$);
