-- D79: a file waiting on the daily picture limit is retried as soon as its owner has enough pages
-- left, not when the date changes. Before, it waited for the next UTC day (4 PM Pacific) even
-- after the limit was raised or when pages were free.

-- How many picture pages the feed's owner can still have read today. None while the monthly AI
-- budget's throttle is on.
create function private.vision_pages_left(p_feed_id uuid)
returns integer
language sql stable set search_path = ''
as $$
  select case when (private.spend_status() ->> 'throttled')::boolean then 0 else greatest(0,
    (private.triage_limits() ->> 'vision_pages_per_day')::int
    - coalesce((select u.amount from private.usage_daily u join public.feeds f on f.owner_id = u.user_id
                where f.id = p_feed_id and u.day = current_date and u.kind = 'vision_pages'), 0)) end
$$;
revoke all on function private.vision_pages_left(uuid) from public;

create or replace function public.requeue_parked_attachments(p_limit integer default 5)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select m.id from public.messages m
    where m.received_at > now() - interval '8 days'
      and exists (
        select 1 from public.attachments a
        where a.message_id = m.id
          and ((a.status = 'pending' and a.triage ->> 'reason' = 'needs_vision_not_configured')
            -- Enough pages for the whole file (D78 reads a file whole: one page for a picture, up
            -- to 30 for a scan), and not tried in the last 10 minutes, so nothing spins.
            or (a.status = 'pending' and a.triage ->> 'reason' = 'daily_vision_limit'
                and a.triaged_at < now() - interval '10 minutes'
                and private.vision_pages_left(m.feed_id) >= least(greatest(coalesce(a.pages, 1), 1), 30))
            or (a.status = 'skipped' and a.triage ->> 'reason' in ('page_budget_used', 'too_many_pages'))))
      and not exists (select 1 from pgmq.q_triage_message q where q.message ->> 'message_id' = m.id::text)
    order by m.received_at desc
    limit least(greatest(coalesce(p_limit, 5), 1), 50)
  loop
    perform pgmq.send('triage_message', jsonb_build_object('message_id', v_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
