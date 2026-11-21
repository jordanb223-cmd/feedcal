-- Phase 17: optional Gmail connection (D39), designed with the owner (2026-11-21):
--   1. Connect Gmail (gmail.readonly, asked for only on "Connect Gmail").
--   2. Search and pick ONE example email that has the calendar information. The search is the
--      owner's own words, over the last 30 days, and shows at most 10 results: sender, subject
--      and date only.
--   3. Feedcal remembers that email's sender and reads the example itself first.
--   4. Every 3 or 7 days (the owner's choice) it asks Gmail only for messages FROM that sender
--      since the last check. Nothing else in the mailbox is searched or read.
-- Raw copies go through the same intake as forwarded email (ingest_start / ingest_commit), so
-- dedupe, the new-sender check, quarantine, daily caps and the AI pipeline apply unchanged.
-- 14-day checks wait for Google verification: unverified ("Testing") apps get refresh tokens that
-- expire after 7 days (developers.google.com/identity/protocols/oauth2, checked 2026-11-21).

create table private.gmail_connections (
  feed_id uuid primary key references public.feeds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  google_email text check (google_email is null or char_length(google_email) <= 320),
  refresh_secret_id uuid,                     -- vault.secrets
  candidates jsonb not null default '[]',     -- the latest search results: [{id, from_email, from_name, subject, date}]
  sender_email text check (sender_email is null or sender_email ~ '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$'),
  sender_name text check (sender_name is null or char_length(sender_name) <= 200),
  example_gmail_id text check (example_gmail_id is null or example_gmail_id ~ '^[A-Za-z0-9]{1,64}$'),
  interval_days integer not null default 7 check (interval_days in (3, 7)),
  status text not null default 'choose_example' check (status in ('choose_example', 'active', 'needs_reconnect')),
  connected_at timestamptz not null default now(),
  reminded_at timestamptz,
  last_checked_at timestamptz,                -- "after:" for the next search
  next_check_at timestamptz,
  last_polled_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  messages_ingested integer not null default 0
);
create index gmail_connections_user_idx on private.gmail_connections (user_id);
create index gmail_connections_due_idx on private.gmail_connections (next_check_at) where status = 'active';
alter table private.gmail_connections enable row level security;
revoke all on table private.gmail_connections from public, anon, authenticated;

-- One-time OAuth states (10 minutes), with the PKCE verifier. Only the state's hash is stored.
create table private.gmail_oauth_states (
  state_hash bytea primary key check (octet_length(state_hash) = 32),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  code_verifier text not null,
  created_at timestamptz not null default now()
);
alter table private.gmail_oauth_states enable row level security;
revoke all on table private.gmail_oauth_states from public, anon, authenticated;

-- Which Gmail messages became which Feedcal messages (dedupe, and deletion on disconnect).
create table private.gmail_messages (
  feed_id uuid not null references public.feeds (id) on delete cascade,
  gmail_id text not null check (char_length(gmail_id) <= 100),
  message_id uuid references public.messages (id) on delete set null,
  outcome text,
  seen_at timestamptz not null default now(),
  primary key (feed_id, gmail_id)
);
create index gmail_messages_message_idx on private.gmail_messages (message_id);
alter table private.gmail_messages enable row level security;
revoke all on table private.gmail_messages from public, anon, authenticated;

-- Only a feed's owner manages its Gmail connection (it reads the owner's mailbox).
create function private.assert_feed_owner(p_feed_id uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.feeds f where f.id = p_feed_id and f.owner_id = (select auth.uid())) then
    raise exception 'Only the feed''s owner can connect Gmail.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.assert_feed_owner(uuid) from public;

-- ---------------------------------------------------------------- owner RPCs (web app)
create function public.gmail_start(p_feed_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_state text := encode(extensions.gen_random_bytes(32), 'hex');
  v_verifier text := rtrim(translate(encode(extensions.gen_random_bytes(48), 'base64'), '+/', '-_'), '=');
begin
  perform private.assert_feed_owner(p_feed_id);
  delete from private.gmail_oauth_states where created_at < now() - interval '10 minutes';
  insert into private.gmail_oauth_states (state_hash, feed_id, user_id, code_verifier)
    values (extensions.digest(v_state, 'sha256'), p_feed_id, (select auth.uid()), v_verifier);
  return jsonb_build_object('state', v_state,
    'code_challenge', rtrim(translate(encode(extensions.digest(v_verifier, 'sha256'), 'base64'), '+/', '-_'), '='));
end;
$$;

create function public.gmail_status(p_feed_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  c private.gmail_connections;
begin
  perform private.assert_feed_owner(p_feed_id);
  select * into c from private.gmail_connections where feed_id = p_feed_id;
  if c.feed_id is null then
    return jsonb_build_object('connected', false);
  end if;
  return jsonb_build_object('connected', true, 'status', c.status, 'google_email', c.google_email, 'candidates', c.candidates,
    'sender_email', c.sender_email, 'sender_name', c.sender_name, 'interval_days', c.interval_days,
    'last_checked_at', c.last_checked_at, 'next_check_at', c.next_check_at, 'last_error', c.last_error,
    'connected_at', c.connected_at, 'reconnect_by', c.connected_at + interval '7 days', 'messages_ingested', c.messages_ingested);
end;
$$;

-- Picks the example from the latest search results (so the sender always comes from a real email
-- in the owner's mailbox) and the schedule. The example itself is read on the next check, at once.
create function public.gmail_choose_example(p_feed_id uuid, p_gmail_id text, p_interval_days integer)
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
    -- Later checks look for mail after the example's date.
    last_checked_at = coalesce((v ->> 'date')::timestamptz, now()), next_check_at = now(),
    status = case when status = 'needs_reconnect' then status else 'active' end
  where feed_id = p_feed_id;
  return true;
end;
$$;

create function public.gmail_set_interval(p_feed_id uuid, p_interval_days integer)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.assert_feed_owner(p_feed_id);
  if p_interval_days not in (3, 7) then
    return false;
  end if;
  update private.gmail_connections set interval_days = p_interval_days,
    next_check_at = coalesce(last_checked_at, now()) + make_interval(days => p_interval_days)
  where feed_id = p_feed_id;
  return found;
end;
$$;

-- "Disconnect Gmail": the token (Vault) and every message copy that came from Gmail go now,
-- and Google is asked to revoke the token (best effort, via pg_net).
create function public.gmail_disconnect(p_feed_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c private.gmail_connections;
  v_token text;
  v_deleted integer;
begin
  perform private.assert_feed_owner(p_feed_id);
  select * into c from private.gmail_connections where feed_id = p_feed_id for update;
  if c.feed_id is null then
    return jsonb_build_object('disconnected', false);
  end if;
  if c.refresh_secret_id is not null then
    select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id = c.refresh_secret_id;
    if v_token is not null then
      -- Google's revoke endpoint takes the token as a URL parameter; it stops working either way.
      perform net.http_post(url := 'https://oauth2.googleapis.com/revoke?token=' || v_token, body := '{}'::jsonb);
    end if;
  end if;
  with gone as (
    delete from public.messages m using private.gmail_messages g
    where g.feed_id = p_feed_id and g.message_id = m.id returning 1)
  select count(*) into v_deleted from gone;
  delete from private.gmail_messages where feed_id = p_feed_id;
  delete from private.gmail_connections where feed_id = p_feed_id;  -- the trigger deletes the Vault token
  delete from private.gmail_oauth_states where feed_id = p_feed_id;
  return jsonb_build_object('disconnected', true, 'messages_deleted', v_deleted);
end;
$$;

revoke all on function public.gmail_start(uuid), public.gmail_status(uuid), public.gmail_choose_example(uuid, text, integer),
  public.gmail_set_interval(uuid, integer), public.gmail_disconnect(uuid) from public, anon;
grant execute on function public.gmail_start(uuid), public.gmail_status(uuid), public.gmail_choose_example(uuid, text, integer),
  public.gmail_set_interval(uuid, integer), public.gmail_disconnect(uuid) to authenticated;

-- ---------------------------------------------------------------- service-role RPCs (Edge Functions)
create function public.gmail_oauth_verifier(p_state text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('feed_id', s.feed_id, 'code_verifier', s.code_verifier)
  from private.gmail_oauth_states s
  where s.state_hash = extensions.digest(coalesce(p_state, ''), 'sha256') and s.created_at > now() - interval '10 minutes'
$$;

-- Finishes connecting: consumes the state and stores the refresh token in Vault. Reconnecting
-- keeps the chosen sender and schedule.
create function public.gmail_oauth_complete(p_state text, p_google_email text, p_refresh_token text)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s private.gmail_oauth_states;
  v_secret uuid;
begin
  delete from private.gmail_oauth_states
    where state_hash = extensions.digest(coalesce(p_state, ''), 'sha256') and created_at > now() - interval '10 minutes'
    returning * into s;
  if s.feed_id is null or p_refresh_token is null or char_length(p_refresh_token) < 10 then
    return null;
  end if;
  select refresh_secret_id into v_secret from private.gmail_connections where feed_id = s.feed_id;
  if v_secret is not null then
    perform vault.update_secret(v_secret, p_refresh_token);
  else
    v_secret := vault.create_secret(p_refresh_token, 'gmail_refresh:' || s.feed_id || ':' || extract(epoch from now())::bigint,
                                    'Gmail refresh token (Phase 17, D39)');
  end if;
  insert into private.gmail_connections (feed_id, user_id, google_email, refresh_secret_id, status, connected_at)
  values (s.feed_id, s.user_id, left(p_google_email, 320), v_secret, 'choose_example', now())
  on conflict (feed_id) do update set user_id = excluded.user_id, google_email = excluded.google_email,
    refresh_secret_id = excluded.refresh_secret_id, connected_at = now(), reminded_at = null, last_error = null,
    status = case when private.gmail_connections.sender_email is not null then 'active' else 'choose_example' end,
    next_check_at = case when private.gmail_connections.sender_email is not null
                         then least(coalesce(private.gmail_connections.next_check_at, now()), now()) end;
  return s.feed_id;
end;
$$;

-- The search for an example: the token, and afterwards the results to keep (owner checked by the
-- Edge Function with the owner's own session first).
create function public.gmail_token(p_feed_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select ds.decrypted_secret from private.gmail_connections c join vault.decrypted_secrets ds on ds.id = c.refresh_secret_id
  where c.feed_id = p_feed_id and c.status <> 'needs_reconnect'
$$;

create function public.gmail_save_candidates(p_feed_id uuid, p_candidates jsonb)
returns void
language sql volatile security definer set search_path = ''
as $$
  update private.gmail_connections set candidates = coalesce(p_candidates, '[]')
  where feed_id = p_feed_id and jsonb_typeof(p_candidates) = 'array' and jsonb_array_length(p_candidates) <= 10
$$;

-- The poller's work list: active connections whose next check is due.
create function public.gmail_claim_checks(p_limit integer default 20)
returns table (feed_id uuid, intake_local_part text, refresh_token text, sender_email text, example_gmail_id text, last_checked_at timestamptz)
language sql volatile security definer set search_path = ''
as $$
  with due as (
    select c.feed_id from private.gmail_connections c
    where c.status = 'active' and c.sender_email is not null and c.next_check_at <= now()
      and (c.last_polled_at is null or c.last_polled_at < now() - interval '4 minutes')
    order by c.next_check_at
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  ), claimed as (
    update private.gmail_connections c set last_polled_at = now() from due where c.feed_id = due.feed_id returning c.*
  )
  select c.feed_id, f.intake_address, ds.decrypted_secret, c.sender_email, c.example_gmail_id, c.last_checked_at
  from claimed c join public.feeds f on f.id = c.feed_id
  left join vault.decrypted_secrets ds on ds.id = c.refresh_secret_id
$$;

create function public.gmail_seen(p_feed_id uuid, p_gmail_ids text[])
returns text[]
language sql stable security definer set search_path = ''
as $$ select coalesce(array_agg(gmail_id), '{}') from private.gmail_messages where feed_id = p_feed_id and gmail_id = any(p_gmail_ids) $$;

create function public.gmail_record(p_feed_id uuid, p_gmail_id text, p_message_id uuid, p_outcome text)
returns void
language sql volatile security definer set search_path = ''
as $$
  insert into private.gmail_messages (feed_id, gmail_id, message_id, outcome) values (p_feed_id, p_gmail_id, p_message_id, left(p_outcome, 40))
  on conflict do nothing;
  update private.gmail_connections set messages_ingested = messages_ingested + 1 where feed_id = p_feed_id and p_message_id is not null;
$$;

-- After a check: schedule the next one, or record the problem. p_reconnect means Google refused
-- the token (revoked, or the 7-day limit): the owner is emailed once.
create function public.gmail_check_done(p_feed_id uuid, p_checked_at timestamptz, p_error text default null, p_reconnect boolean default false)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c private.gmail_connections;
begin
  update private.gmail_connections set
    last_checked_at = case when p_error is null then p_checked_at else last_checked_at end,
    next_check_at = case when p_error is null then p_checked_at + make_interval(days => interval_days)
                         else now() + interval '1 hour' end,  -- a passing failure: try again in an hour
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

revoke all on function public.gmail_oauth_verifier(text), public.gmail_oauth_complete(text, text, text), public.gmail_token(uuid),
  public.gmail_save_candidates(uuid, jsonb), public.gmail_claim_checks(integer), public.gmail_seen(uuid, text[]),
  public.gmail_record(uuid, text, uuid, text), public.gmail_check_done(uuid, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.gmail_oauth_verifier(text), public.gmail_oauth_complete(text, text, text), public.gmail_token(uuid),
  public.gmail_save_candidates(uuid, jsonb), public.gmail_claim_checks(integer), public.gmail_seen(uuid, text[]),
  public.gmail_record(uuid, text, uuid, text), public.gmail_check_done(uuid, timestamptz, text, boolean) to service_role;

-- A day before the 7-day limit, remind the owner to reconnect (unverified apps; D39).
create function private.gmail_reminders()
returns integer
language plpgsql volatile set search_path = ''
as $$
declare
  n integer := 0;
  c record;
begin
  for c in select g.*, f.name from private.gmail_connections g join public.feeds f on f.id = g.feed_id
           where g.status = 'active' and g.reminded_at is null and g.connected_at < now() - interval '6 days' loop
    perform private.enqueue_email(c.user_id, 'gmail_reconnect', 'gmail_reconnect:' || c.feed_id || ':' || to_char(c.connected_at, 'YYYYMMDDHH24MISS'),
      jsonb_build_object('feed_id', c.feed_id, 'feed_name', c.name, 'expired', false));
    update private.gmail_connections set reminded_at = now() where feed_id = c.feed_id;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function private.gmail_reminders() from public;

alter table private.email_outbox drop constraint email_outbox_kind_check;
alter table private.email_outbox add constraint email_outbox_kind_check
  check (kind in ('weekly_digest', 'report', 'stale_nudge', 'milestone', 'supporter_thanks', 'ops_alert', 'gmail_reconnect'));

-- Checks are days apart; looking every 5 minutes just means a new example is read within minutes.
select cron.schedule('feedcal-gmail-poll', '*/5 * * * *', $$ select private.call_edge_function('gmail-poll') $$);
select cron.schedule('feedcal-gmail-reminders', '13 * * * *', $$ select private.gmail_reminders() $$);

-- Deleting a connection, feed or account removes its Vault token too.
create function private.gmail_connections_drop_secret()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.refresh_secret_id is not null then
    delete from vault.secrets where id = old.refresh_secret_id;
  end if;
  return old;
end;
$$;
create trigger gmail_connections_drop_secret after delete on private.gmail_connections
  for each row execute function private.gmail_connections_drop_secret();
