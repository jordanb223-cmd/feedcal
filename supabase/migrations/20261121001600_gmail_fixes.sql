-- Phase 17 fixes from the first live run (D39, 2026-11-21).
--  1. Changing the schedule pushed the FIRST check (the one that reads the example) a week out.
--     Now a pending example keeps the check due now.
--  2. When more mail is waiting than one run takes, carry on in 5 minutes instead of waiting for
--     the next scheduled check (runs now read 3 emails each, to fit Supabase's per-run limits).

create or replace function public.gmail_set_interval(p_feed_id uuid, p_interval_days integer)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.assert_feed_owner(p_feed_id);
  if p_interval_days not in (3, 7) then
    return false;
  end if;
  update private.gmail_connections set interval_days = p_interval_days,
    next_check_at = case when example_gmail_id is not null then least(coalesce(next_check_at, now()), now())
                         else coalesce(last_checked_at, now()) + make_interval(days => p_interval_days) end
  where feed_id = p_feed_id;
  return found;
end;
$$;

drop function public.gmail_check_done(uuid, timestamptz, text, boolean);
create function public.gmail_check_done(p_feed_id uuid, p_checked_at timestamptz, p_error text default null,
                                        p_reconnect boolean default false, p_more boolean default false)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c private.gmail_connections;
begin
  update private.gmail_connections set
    last_checked_at = case when p_error is null then p_checked_at else last_checked_at end,
    next_check_at = case when p_error is not null then now() + interval '1 hour'   -- a passing failure: retry in an hour
                         when p_more then now() + interval '5 minutes'             -- more waiting: carry on soon
                         else p_checked_at + make_interval(days => interval_days) end,
    -- The example counts as read once a run finishes without error (it is first in every run).
    example_gmail_id = case when p_error is null then null else example_gmail_id end,
    last_error = left(p_error, 300),
    status = case when p_reconnect then 'needs_reconnect' else status end
  where feed_id = p_feed_id returning * into c;
  if p_reconnect and c.feed_id is not null then
    perform private.enqueue_email(c.user_id, 'gmail_reconnect', 'gmail_reconnect:' || c.feed_id || ':' || to_char(c.connected_at, 'YYYYMMDDHH24MISS'),
      jsonb_build_object('feed_id', c.feed_id, 'feed_name', (select name from public.feeds where id = c.feed_id), 'expired', true));
  end if;
end;
$$;
revoke all on function public.gmail_check_done(uuid, timestamptz, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.gmail_check_done(uuid, timestamptz, text, boolean, boolean) to service_role;
