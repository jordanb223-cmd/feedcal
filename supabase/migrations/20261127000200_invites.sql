-- D94: an organizer can have Bumpdraft email one person an invitation to follow a calendar.
--
-- Sending mail to an address its owner never gave us is the risk here, so:
--   * only for a calendar that has a page (public or "anyone with the link"). A private
--     calendar's only link is its secret calendar link, which is not put in a queued email;
--   * 10 invitations per organizer per day, one per calendar and address per 30 days, and 50 a
--     day across the whole service, so invitations can't use up the provider's daily allowance;
--   * anyone invited can say "don't email me again", and that is checked before every send;
--   * the address sits in the queued email only until it is sent (or has failed 5 times). After
--     that only a keyed hash of it is kept, for the limits and the "don't email me" list.
alter table private.email_outbox drop constraint email_outbox_kind_check;
alter table private.email_outbox add constraint email_outbox_kind_check check (kind in (
  'weekly_digest', 'report', 'stale_nudge', 'milestone', 'supporter_thanks', 'ops_alert', 'gmail_reconnect', 'contact', 'events_published', 'invite'));

create table private.invites (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  sender_id uuid references public.profiles (id) on delete set null,
  recipient_hash bytea not null check (octet_length(recipient_hash) = 32),
  created_at timestamptz not null default now()
);
create index invites_sender_idx on private.invites (sender_id, created_at);
create index invites_feed_recipient_idx on private.invites (feed_id, recipient_hash, created_at);
create index invites_recipient_idx on private.invites (recipient_hash);
create index invites_created_idx on private.invites (created_at);
alter table private.invites enable row level security;
revoke all on table private.invites from public, anon, authenticated;

create table private.invite_optouts (
  recipient_hash bytea primary key check (octet_length(recipient_hash) = 32),
  at timestamptz not null default now()
);
alter table private.invite_optouts enable row level security;
revoke all on table private.invite_optouts from public, anon, authenticated;

create function private.invite_hash(p_email text)
returns bytea
language sql stable set search_path = ''
as $$
  select extensions.digest((select key from private.notification_key) || convert_to(lower(btrim(p_email)), 'UTF8'), 'sha256');
$$;
revoke all on function private.invite_hash(text) from public, anon, authenticated;

-- Returns one word: sent, invalid, not_allowed, private, opted_out, already, limit, busy.
create function public.send_invite(p_feed_id uuid, p_email text)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_hash bytea;
  v_id uuid;
  f record;
begin
  if v_user is null or not private.is_feed_member(p_feed_id) then
    return 'not_allowed';
  end if;
  if char_length(v_email) > 254 or v_email !~ '^[^[:space:]@<>",;:()\[\]\\]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$' then
    return 'invalid';
  end if;
  select fd.name, fd.slug, fd.visibility into f from public.feeds fd
    where fd.id = p_feed_id and fd.hidden_at is null and fd.delete_requested_at is null;
  if not found then
    return 'not_allowed';
  end if;
  if f.visibility = 'private' then
    return 'private';
  end if;
  v_hash := private.invite_hash(v_email);
  if exists (select 1 from private.invite_optouts o where o.recipient_hash = v_hash) then
    return 'opted_out';
  end if;
  if exists (select 1 from private.invites i where i.feed_id = p_feed_id and i.recipient_hash = v_hash and i.created_at > now() - interval '30 days') then
    return 'already';
  end if;
  if (select count(*) from private.invites i where i.sender_id = v_user and i.created_at > now() - interval '1 day') >= 10 then
    return 'limit';
  end if;
  if (select count(*) from private.invites i where i.created_at > now() - interval '1 day') >= 50 then
    return 'busy';
  end if;
  insert into private.invites (feed_id, sender_id, recipient_hash) values (p_feed_id, v_user, v_hash) returning id into v_id;
  insert into private.email_outbox (user_id, kind, dedupe_key, payload) values (
    v_user, 'invite', 'invite:' || v_id,
    jsonb_build_object('to', v_email, 'feed_name', f.name, 'slug', f.slug,
      'from_name', (select p.display_name from public.profiles p where p.id = v_user),
      'stop', encode(v_hash, 'hex')));
  return 'sent';
end;
$$;
revoke all on function public.send_invite(uuid, text) from public, anon;
grant execute on function public.send_invite(uuid, text) to authenticated;

-- "Don't email me again", from the link in an invitation. The token is the keyed hash of the
-- address, so only someone who was invited holds one; a token that matches no invitation does nothing.
create function public.invite_stop(p_token text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_hash bytea;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  v_hash := decode(p_token, 'hex');
  if not exists (select 1 from private.invites i where i.recipient_hash = v_hash)
     and not exists (select 1 from private.invite_optouts o where o.recipient_hash = v_hash) then
    return false;
  end if;
  insert into private.invite_optouts (recipient_hash) values (v_hash) on conflict do nothing;
  return true;
end;
$$;
revoke all on function public.invite_stop(text) from public;
grant execute on function public.invite_stop(text) to anon, authenticated;

-- An invitation's address leaves the queue as soon as the email is sent or has finally failed.
create or replace function public.mark_outbox(p_id uuid, p_sent boolean, p_provider_id text default null, p_error text default null)
returns void
language sql volatile security definer set search_path = ''
as $$
  update private.email_outbox set
    state = case when p_sent then 'sent' when attempts >= 5 then 'failed' else 'queued' end,
    sent_at = case when p_sent then now() end, provider_id = left(p_provider_id, 200), last_error = left(p_error, 500),
    payload = case when kind = 'invite' and (p_sent or attempts >= 5) then payload - 'to' else payload end
  where id = p_id
$$;

-- The invitation log (hashes only) is kept 90 days. The "don't email me" list is kept.
create or replace function private.apply_retention()
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_fetch integer;
  v_outbox integer;
  v_questions integer;
  v_chat integer;
  v_hashes integer;
  v_invites integer;
begin
  delete from public.feed_fetch_daily where day < current_date - 400;
  get diagnostics v_fetch = row_count;
  update private.email_outbox set payload = '{}'::jsonb, last_error = null
    where state in ('sent', 'failed') and created_at < now() - interval '30 days' and payload <> '{}'::jsonb;
  get diagnostics v_outbox = row_count;

  delete from public.event_questions q using public.events e
    where e.id = q.event_id and private.event_over_since(e) < now() - interval '30 days';
  get diagnostics v_questions = row_count;
  delete from public.event_chat_messages m using public.events e
    where e.id = m.event_id and private.event_over_since(e) < now() - interval '30 days';
  get diagnostics v_chat = row_count;
  update public.event_questions set asker_hash = null
    where asker_hash is not null and created_at < now() - interval '1 hour';
  get diagnostics v_hashes = row_count;
  delete from private.invites where created_at < now() - interval '90 days';
  get diagnostics v_invites = row_count;

  return jsonb_build_object('fetch_rows_deleted', v_fetch, 'outbox_payloads_cleared', v_outbox,
    'questions_deleted', v_questions, 'chat_messages_deleted', v_chat, 'question_codes_cleared', v_hashes,
    'invites_deleted', v_invites);
end;
$$;
revoke all on function private.apply_retention() from public;
