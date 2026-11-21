-- Phase 17: optional 30-day look-back (D39 addendum, 2026-11-21, owner's request).
-- Before, Feedcal read the example and then only mail newer than it. Now the owner can also have
-- it read earlier emails from the same sender, back to 30 days before the example (when picking
-- the example), or back to 30 days before now (a button on an already-connected calendar).
-- The sender stays the only thing searched. Runs read 3 emails and continue 5 minutes later.

drop function public.gmail_choose_example(uuid, text, integer);
create function public.gmail_choose_example(p_feed_id uuid, p_gmail_id text, p_interval_days integer,
                                            p_look_back boolean default false)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.assert_feed_owner(p_feed_id);
  if p_interval_days not in (3, 7) then
    return false;
  end if;
  select x into v from private.gmail_connections c, jsonb_array_elements(c.candidates) x
    where c.feed_id = p_feed_id and x ->> 'id' = p_gmail_id;
  if v is null or coalesce(v ->> 'from_email', '') !~ '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$' then
    return false;
  end if;
  update private.gmail_connections set
    sender_email = lower(v ->> 'from_email'), sender_name = left(v ->> 'from_name', 200), example_gmail_id = p_gmail_id,
    interval_days = p_interval_days, candidates = '[]',
    -- Later checks look for mail after this point: the example's date, or 30 days before it.
    last_checked_at = coalesce((v ->> 'date')::timestamptz, now())
                      - case when p_look_back then interval '30 days' else interval '0' end,
    next_check_at = now(),
    status = case when status = 'needs_reconnect' then status else 'active' end
  where feed_id = p_feed_id;
  return true;
end;
$$;

-- "Read the last 30 days" on an active connection: move the starting point back and check now.
-- Emails already read are skipped (private.gmail_messages), so pressing it twice is harmless.
create function public.gmail_look_back(p_feed_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.assert_feed_owner(p_feed_id);
  update private.gmail_connections set
    last_checked_at = least(coalesce(last_checked_at, now()), now() - interval '30 days'),
    next_check_at = now()
  where feed_id = p_feed_id and status = 'active' and sender_email is not null;
  return found;
end;
$$;

revoke all on function public.gmail_choose_example(uuid, text, integer, boolean), public.gmail_look_back(uuid) from public, anon;
grant execute on function public.gmail_choose_example(uuid, text, integer, boolean), public.gmail_look_back(uuid) to authenticated;
