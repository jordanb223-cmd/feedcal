-- Phase 5: the public subscribe page and subscribe-button counts [Rev 1, Rev 3, Rev 4].

-- public_feed_page now also returns the subscription token, for public and unlisted feeds only.
-- Rev 1: a public feed's link is public by design; an unlisted page is reached only through
-- its unguessable slug, so its link is exactly as secret as the page itself. Private feeds still
-- return null here, and their token is readable only by owners/editors (get_feed_token).
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
      'subscribers_at_least', (
        select count(distinct d.client_hash) from public.feed_fetch_daily d
        where d.feed_id = f.id and d.day > current_date - 7
      ),
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

-- One tap on a subscribe button: +1 for (feed, today, platform). No personal data at all.
-- Only public/unlisted feeds have a page with buttons, so only they count. Returns whether it counted.
create function public.record_subscribe_click(p_slug text, p_platform text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed uuid;
begin
  if p_platform is null or p_platform not in ('apple', 'google', 'outlook', 'copy_link', 'other') then
    return false;
  end if;
  select id into v_feed from public.feeds where slug = p_slug and visibility in ('public', 'unlisted');
  if v_feed is null then
    return false;
  end if;
  insert into public.subscribe_clicks (feed_id, day, platform, count)
  values (v_feed, current_date, p_platform, 1)
  on conflict (feed_id, day, platform) do update set count = public.subscribe_clicks.count + 1;
  return true;
end;
$$;
revoke all on function public.record_subscribe_click(text, text) from public;
grant execute on function public.record_subscribe_click(text, text) to anon, authenticated, service_role;

-- Owners/editors see their feed's click totals (the table itself stays service-role only).
create function public.feed_subscribe_stats(p_feed_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.is_feed_member(p_feed_id) then jsonb_build_object(
    'subscribers_at_least', (select count(distinct d.client_hash) from public.feed_fetch_daily d
                             where d.feed_id = p_feed_id and d.day > current_date - 7),
    'clicks_30d', coalesce((select jsonb_object_agg(platform, n) from (
        select platform, sum(count)::int as n from public.subscribe_clicks
        where feed_id = p_feed_id and day > current_date - 30 group by platform) s), '{}'::jsonb)
  ) end;
$$;
revoke all on function public.feed_subscribe_stats(uuid) from public, anon;
grant execute on function public.feed_subscribe_stats(uuid) to authenticated;
