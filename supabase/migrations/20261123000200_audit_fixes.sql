-- Fixes from the project audit (D69).

-- ---------------------------------------------------------------- waiting emails are retried
-- An email that could not be read yet (no API key, the owner's daily limit, or the monthly budget
-- throttle) was marked "waiting" and stayed there until someone ran requeue_waiting_extractions()
-- by hand. Now it runs every hour. An email that is already back in the queue is not sent twice.
create or replace function public.requeue_waiting_extractions(p_limit integer default 100)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in select m.id from public.messages m
              where m.extraction ->> 'state' = 'waiting' and m.status = 'parsed'
                and not exists (select 1 from pgmq.q_extract_message q where q.message ->> 'message_id' = m.id::text)
              order by m.received_at limit least(greatest(p_limit, 1), 1000) loop
    perform pgmq.send('extract_message', jsonb_build_object('message_id', v_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

select cron.schedule('feedcal-requeue-waiting', '37 * * * *', $$ select public.requeue_waiting_extractions(200) $$);

-- ---------------------------------------------------------------- repeating events from imports
-- The coming starts of a repeating event, worked out by the importer (which can read the rule).
-- Pages use it to show the next date; without it a weekly event vanished after its first date.
alter table public.events add column occurrences timestamptz[] not null default '{}'
  check (cardinality(occurrences) <= 120);

-- The next start worth showing: the event's own start while it has not ended, else the next
-- coming date of a repeating event. Null when nothing is left.
create function private.next_start(p_starts_at timestamptz, p_ends_at timestamptz, p_occurrences timestamptz[])
returns timestamptz
language sql stable set search_path = ''
as $$
  select case when coalesce(p_ends_at, p_starts_at) >= now() then p_starts_at
              else (select min(o) from unnest(p_occurrences) o where o >= now()) end
$$;
revoke all on function private.next_start(timestamptz, timestamptz, timestamptz[]) from public;

-- As before (20261121002000), plus: removed dates and coming dates are stored.
create or replace function public.record_import(p_feed_id uuid, p_events jsonb)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e jsonb;
  v integer := 0;
  v_ex timestamptz[];
  v_occ timestamptz[];
begin
  if not exists (select 1 from public.feeds where id = p_feed_id and import_url is not null) then
    return 0;
  end if;
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) limit 2000 loop
    v_ex := coalesce((select array_agg(x::timestamptz) from (select x from jsonb_array_elements_text(
      case when jsonb_typeof(e -> 'exdates') = 'array' then e -> 'exdates' else '[]'::jsonb end) x limit 500) s), '{}');
    v_occ := coalesce((select array_agg(x::timestamptz order by x::timestamptz) from (select x from jsonb_array_elements_text(
      case when jsonb_typeof(e -> 'occurrences') = 'array' then e -> 'occurrences' else '[]'::jsonb end) x limit 120) s), '{}');
    insert into public.events (feed_id, external_uid, title, description, location, starts_at, ends_at, all_day, timezone, rrule, exdates, occurrences, status, published)
    values (p_feed_id, left(e ->> 'uid', 500), left(coalesce(nullif(e ->> 'title', ''), 'Event'), 300), left(e ->> 'description', 8000),
            left(e ->> 'location', 500), (e ->> 'starts_at')::timestamptz, (e ->> 'ends_at')::timestamptz,
            coalesce((e ->> 'all_day')::boolean, false), coalesce(e ->> 'timezone', 'America/Los_Angeles'), left(e ->> 'rrule', 500),
            v_ex, v_occ,
            case when e ->> 'status' = 'cancelled' then 'cancelled' else 'confirmed' end, true)
    on conflict (feed_id, external_uid) where external_uid is not null do update set
      title = excluded.title, description = excluded.description, location = excluded.location, starts_at = excluded.starts_at,
      ends_at = excluded.ends_at, all_day = excluded.all_day, timezone = excluded.timezone, rrule = excluded.rrule,
      exdates = excluded.exdates, occurrences = excluded.occurrences,
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

-- As before (latest definition), plus: a repeating event stays on the page while it has a coming
-- date, shown at that date, and is marked "repeats".
create or replace function public.public_feed_page(p_slug text, p_limit integer default 50)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with f as (
    select fd.id, fd.name, fd.slug, fd.description, fd.category, fd.zip_code, fd.visibility, fd.verified,
           fd.last_updated_at, fd.feed_token_secret_id, p.display_name as organizer_name
    from public.feeds fd
    left join public.profiles p on p.id = fd.owner_id and p.deleted_at is null
    where fd.slug = p_slug and fd.visibility in ('public', 'unlisted') and fd.hidden_at is null
  )
  select jsonb_build_object(
    'feed', jsonb_build_object(
      'id', f.id, 'name', f.name, 'slug', f.slug, 'description', f.description,
      'category', f.category, 'zip_code', f.zip_code, 'visibility', f.visibility, 'verified', f.verified,
      'last_updated_at', f.last_updated_at, 'organizer_name', f.organizer_name,
      'area', (select z.city || ', ' || z.state from public.zip_codes z where z.zip = f.zip_code),
      'subscribers_at_least', private.subscriber_estimate(f.id, current_date - 7, current_date),
      'may_be_out_of_date', f.last_updated_at < now() - interval '90 days',
      'feed_token', (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.id = f.feed_token_secret_id)
    ),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'uid', e.uid, 'title', e.title, 'description', e.description,
        'location', e.location, 'starts_at', e.next_at, 'ends_at', e.ends_at + (e.next_at - e.starts_at),
        'all_day', e.all_day, 'timezone', e.timezone, 'rrule', e.rrule, 'status', e.status,
        'repeats', e.rrule is not null
      ) order by e.next_at)
      from (
        select ev.*, private.next_start(ev.starts_at, ev.ends_at, ev.occurrences) as next_at from public.events ev
        where ev.feed_id = f.id and ev.published and ev.status <> 'cancelled'
          and private.next_start(ev.starts_at, ev.ends_at, ev.occurrences) is not null
        order by next_at
        limit least(greatest(coalesce(p_limit, 50), 1), 200)
      ) e
    ), '[]'::jsonb)
  )
  from f;
$$;
