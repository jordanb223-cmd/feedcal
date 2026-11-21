-- Phase 4: serve a feed by its secret token [Rev 1], and count fetches without storing IPs.

-- One random salt per day. A client hash can't be linked across days, and the raw IP
-- and user agent never reach a table or a log.
create table private.fetch_salts (
  day date primary key,
  salt bytea not null default extensions.gen_random_bytes(32)
);
alter table private.fetch_salts enable row level security;
revoke all on table private.fetch_salts from public, anon, authenticated;

-- Looks up the feed by sha256(token), records one fetch row per client per day, and returns
-- the calendar data. Null when the token is unknown or malformed.
-- Events: published ones; cancelled ones stay 30 days after cancelling so calendars remove them.
create function public.feed_calendar(p_token text, p_client_ip text default null,
                                     p_user_agent text default null, p_ua_family text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed public.feeds%rowtype;
  v_salt bytea;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    return null;
  end if;
  select * into v_feed from public.feeds where feed_token_hash = private.token_hash(p_token);
  if not found then
    return null;
  end if;

  if p_client_ip is not null then
    insert into private.fetch_salts (day) values (current_date) on conflict (day) do nothing;
    select salt into v_salt from private.fetch_salts where day = current_date;
    insert into public.feed_fetch_daily (feed_id, day, client_hash, user_agent_family)
    values (v_feed.id, current_date,
            sha256(v_salt || convert_to(left(p_client_ip, 64) || '|' || left(coalesce(p_user_agent, ''), 512), 'UTF8')),
            left(p_ua_family, 40))
    on conflict do nothing;
    delete from private.fetch_salts where day < current_date - 2;
  end if;

  return jsonb_build_object(
    'feed', jsonb_build_object(
      'id', v_feed.id, 'name', v_feed.name, 'slug', v_feed.slug, 'description', v_feed.description,
      'visibility', v_feed.visibility, 'last_updated_at', v_feed.last_updated_at),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'uid', e.uid, 'title', e.title, 'description', e.description,
        'location', e.location, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'all_day', e.all_day,
        'timezone', e.timezone, 'rrule', e.rrule, 'status', e.status, 'sequence', e.sequence,
        'created_at', e.created_at, 'updated_at', e.updated_at,
        -- Source line: the sender's domain only, never the address.
        'source', (select s.sender_domain from public.messages m join public.sources s on s.id = m.source_id
                   where m.id = e.source_message_id)
      ) order by e.starts_at)
      from (
        select * from public.events ev
        where ev.feed_id = v_feed.id and ev.published
          and (ev.status <> 'cancelled' or ev.updated_at > now() - interval '30 days')
        order by ev.starts_at
        limit 2000
      ) e
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.feed_calendar(text, text, text, text) from public;
grant execute on function public.feed_calendar(text, text, text, text) to anon, authenticated, service_role;
