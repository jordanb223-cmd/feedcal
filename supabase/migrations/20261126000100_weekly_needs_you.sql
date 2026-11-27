-- D91: the Monday email lists what is waiting, not only how many. For each calendar it carries
-- the first 8 waiting items (changes Bumpdraft held back, and events it found but did not add),
-- soonest first, and the first 5 follower questions nobody has answered. The counts stay exact;
-- the email says how many more there are. Titles and questions already reach the organizer on
-- the Review page; this sends the same text to the same person, to the address they sign in with.
create or replace function private.digest_payload(p_user uuid)
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
      'reports', (select count(*)::int from public.reports r where r.feed_id = f.id and r.created_at > now() - interval '7 days'),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('title', w.title, 'starts_at', w.starts_at, 'all_day', w.all_day, 'timezone', w.timezone,
                                            'reasons', w.reasons, 'outcome', w.outcome, 'change_kind', w.change_kind)
                         order by w.starts_at, w.title)
        from (
          select * from (
            select c.title, c.starts_at, c.all_day, c.timezone, to_jsonb(c.review_reasons) as reasons, c.outcome, c.change_kind
            from public.event_candidates c where c.feed_id = f.id and c.state = 'needs_review'
            union all
            select e.title, e.starts_at, e.all_day, e.timezone,
                   coalesce((select to_jsonb(c.review_reasons) from public.event_candidates c
                             where c.event_id = e.id and c.outcome = 'new' order by c.created_at desc limit 1), '[]'::jsonb),
                   'new', 'new'
            from public.events e where e.feed_id = f.id and not e.published and e.status = 'tentative'
          ) u order by u.starts_at, u.title limit 8
        ) w), '[]'::jsonb),
      'open_questions', (select count(*)::int from public.event_questions q where q.feed_id = f.id and q.status = 'open'),
      'questions', coalesce((
        select jsonb_agg(jsonb_build_object('body', w.body, 'event_title', w.title, 'starts_at', w.starts_at, 'all_day', w.all_day, 'timezone', w.timezone)
                         order by w.created_at)
        from (
          select q.body, q.created_at, e.title, e.starts_at, e.all_day, e.timezone
          from public.event_questions q join public.events e on e.id = q.event_id
          where q.feed_id = f.id and q.status = 'open' order by q.created_at limit 5
        ) w), '[]'::jsonb)
    ) order by f.name), '[]'::jsonb))
  from public.feeds f join public.feed_editors fe on fe.feed_id = f.id
  where fe.user_id = p_user and f.delete_requested_at is null
$$;
revoke all on function private.digest_payload(uuid) from public;
