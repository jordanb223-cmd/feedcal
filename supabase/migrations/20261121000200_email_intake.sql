-- Phase 6: inbound email by forwarding (D26).
-- Flow: Email Worker -> ingest-start (ticket) -> upload raw MIME to private bucket -> ingest-commit
-- (dedupe, sender allowlist, quarantine, enqueue). Nothing here parses the email body; Phase 7 does.
-- Only the service role calls the ingest functions. Owners and editors decide on quarantined mail.

create extension if not exists pgmq;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select pgmq.create('process_message');

-- ---------------------------------------------------------------- limits, defined once
create function private.intake_limits()
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'max_bytes', 20 * 1024 * 1024,
    'max_attachments', 10,
    'per_feed_per_day', 50,
    'ticket_minutes', 15,
    'confirmation_days', 7)
$$;
revoke all on function private.intake_limits() from public;

-- ---------------------------------------------------------------- intake addresses
-- feed-<20 base32 chars>: 100 random bits. 256 is a multiple of 32, so byte % 32 has no bias.
create function private.new_intake_address()
returns text
language sql volatile set search_path = ''
as $$
  select 'feed-' || string_agg(substr('abcdefghijklmnopqrstuvwxyz234567', get_byte(x.b, i) % 32 + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(20) as b) x, generate_series(0, 19) i
$$;
revoke all on function private.new_intake_address() from public;

create function private.feeds_set_intake_address()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.intake_address := coalesce(new.intake_address, private.new_intake_address());
  return new;
end;
$$;
revoke all on function private.feeds_set_intake_address() from public;
create trigger feeds_set_intake_address before insert on public.feeds
  for each row execute function private.feeds_set_intake_address();

update public.feeds set intake_address = private.new_intake_address() where intake_address is null;
alter table public.feeds
  alter column intake_address set not null,
  add constraint feeds_intake_address_format check (intake_address ~ '^feed-[a-z2-7]{20}$');

-- A new address when the old one gets spam. Owner only. The old one stops working at once.
create function public.rotate_intake_address(p_feed_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_address text;
begin
  if private.feed_role(p_feed_id) is distinct from 'owner' then
    raise exception 'Only the feed''s owner can change its email address.' using errcode = '42501';
  end if;
  update public.feeds set intake_address = private.new_intake_address()
    where id = p_feed_id returning intake_address into v_address;
  return v_address;
end;
$$;
revoke all on function public.rotate_intake_address(uuid) from public;
grant execute on function public.rotate_intake_address(uuid) to authenticated;

-- ---------------------------------------------------------------- sources: blocking
alter table public.sources add column blocked boolean not null default false;
-- Trust changes go through decide_sender(), which also releases or ignores waiting mail.
revoke update (trusted) on table public.sources from authenticated;

-- ---------------------------------------------------------------- messages: intake facts
alter table public.messages
  add column raw_bytes integer check (raw_bytes is null or raw_bytes >= 0),
  add column attachment_count smallint check (attachment_count is null or attachment_count >= 0),
  add column auth_spf text check (auth_spf is null or auth_spf ~ '^[a-z]{1,12}$'),
  add column auth_dkim text check (auth_dkim is null or auth_dkim ~ '^[a-z]{1,12}$'),
  add column auth_dmarc text check (auth_dmarc is null or auth_dmarc ~ '^[a-z]{1,12}$'),
  -- Set while a message waits for an owner's decision. Status stays 'received' meanwhile.
  add column quarantine_reason text check (quarantine_reason is null or quarantine_reason in ('new_sender', 'failed_authentication'));
-- The same email forwarded twice is stored once: same Message-ID (existing index) or same body.
create unique index messages_feed_body_idx on public.messages (feed_id, sha256) where sha256 is not null;
create index messages_quarantine_idx on public.messages (feed_id) where quarantine_reason is not null;

-- ---------------------------------------------------------------- upload tickets
create table private.ingest_tickets (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  storage_path text not null unique,
  declared_bytes bigint not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  committed_at timestamptz,
  result jsonb
);
create index ingest_tickets_feed_created_idx on private.ingest_tickets (feed_id, created_at);
alter table private.ingest_tickets enable row level security;
revoke all on table private.ingest_tickets from public, anon, authenticated;

-- Files waiting to be deleted through the Storage API (SQL can't delete stored files:
-- storage.protect_delete). Drained by the storage-trash Edge Function.
create table private.storage_trash (
  id bigint generated always as identity primary key,
  bucket text not null,
  path text not null,
  queued_at timestamptz not null default now(),
  unique (bucket, path)
);
alter table private.storage_trash enable row level security;
revoke all on table private.storage_trash from public, anon, authenticated;

create function private.trash(p_bucket text, p_path text)
returns void
language sql volatile set search_path = ''
as $$
  insert into private.storage_trash (bucket, path) values (p_bucket, p_path) on conflict do nothing
$$;
revoke all on function private.trash(text, text) from public;

-- ---------------------------------------------------------------- Gmail forwarding confirmations
create table public.forwarding_confirmations (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  provider text not null check (provider in ('gmail')),
  code text not null check (code ~ '^[0-9]{6,12}$'),
  confirm_url text check (confirm_url is null or confirm_url ~ '^https://(mail-settings\.google\.com|mail\.google\.com)/'),
  requested_by text check (requested_by is null or char_length(requested_by) <= 320),
  received_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index forwarding_confirmations_feed_idx on public.forwarding_confirmations (feed_id, received_at desc);
alter table public.forwarding_confirmations enable row level security;
revoke all on table public.forwarding_confirmations from anon, authenticated;
grant select on table public.forwarding_confirmations to authenticated;
create policy forwarding_confirmations_member_select on public.forwarding_confirmations
  for select to authenticated using (private.is_feed_member(feed_id));

-- ---------------------------------------------------------------- ingest_start (service role)
-- Checks the address, size and daily cap, then issues a one-time upload ticket.
create function public.ingest_start(p_local_part text, p_bytes bigint)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_limits jsonb := private.intake_limits();
  v_feed_id uuid;
  v_ticket uuid := gen_random_uuid();
  v_path text;
begin
  if p_local_part is null or lower(p_local_part) !~ '^feed-[a-z2-7]{20}$' then
    return jsonb_build_object('ok', false, 'reject', 'unknown_address');
  end if;
  select id into v_feed_id from public.feeds where intake_address = lower(p_local_part);
  if v_feed_id is null then
    return jsonb_build_object('ok', false, 'reject', 'unknown_address');
  end if;
  if p_bytes is null or p_bytes < 0 or p_bytes > (v_limits ->> 'max_bytes')::bigint then
    return jsonb_build_object('ok', false, 'reject', 'too_large');
  end if;
  -- Accepted messages plus in-flight tickets in the last 24 hours.
  if (select count(*) from private.ingest_tickets
      where feed_id = v_feed_id and created_at > now() - interval '24 hours'
        and (committed_at is null or (result ->> 'outcome') in ('queued', 'quarantined')))
     >= (v_limits ->> 'per_feed_per_day')::int then
    return jsonb_build_object('ok', false, 'reject', 'daily_limit');
  end if;
  v_path := v_feed_id || '/' || v_ticket || '.eml';
  insert into private.ingest_tickets (id, feed_id, storage_path, declared_bytes, expires_at)
  values (v_ticket, v_feed_id, v_path, p_bytes, now() + make_interval(mins => (v_limits ->> 'ticket_minutes')::int));
  return jsonb_build_object('ok', true, 'ticket', v_ticket, 'path', v_path);
end;
$$;
revoke all on function public.ingest_start(text, bigint) from public, anon, authenticated;
grant execute on function public.ingest_start(text, bigint) to service_role;

-- ---------------------------------------------------------------- ingest_commit (service role)
-- Called after the raw file is uploaded and its headers read (server side, never in the Worker).
-- Safe to call twice: a committed ticket returns its first result.
create function public.ingest_commit(
  p_ticket uuid,
  p_path text,
  p_raw_bytes bigint,
  p_message_id_header text,
  p_sender text,
  p_subject text,
  p_body_sha256 bytea,
  p_attachment_count integer,
  p_spf text default null,
  p_dkim text default null,
  p_dmarc text default null,
  p_gmail_confirmation jsonb default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_limits jsonb := private.intake_limits();
  v_t private.ingest_tickets%rowtype;
  v_sender text := nullif(lower(trim(p_sender)), '');
  v_source public.sources%rowtype;
  v_reason text;
  v_message_id uuid;
  v_result jsonb;
begin
  select * into v_t from private.ingest_tickets where id = p_ticket for update;
  if not found or v_t.storage_path is distinct from p_path then
    return jsonb_build_object('ok', false, 'reject', 'unknown_ticket');
  end if;
  if v_t.committed_at is not null then
    return v_t.result;
  end if;
  if v_t.expires_at < now() then
    perform private.trash('inbound-raw', v_t.storage_path);
    v_result := jsonb_build_object('ok', false, 'reject', 'expired', 'delete_raw', true);
  elsif p_raw_bytes is null or p_raw_bytes > (v_limits ->> 'max_bytes')::bigint then
    perform private.trash('inbound-raw', v_t.storage_path);
    v_result := jsonb_build_object('ok', false, 'reject', 'too_large', 'delete_raw', true);
  elsif coalesce(p_attachment_count, 0) > (v_limits ->> 'max_attachments')::int then
    perform private.trash('inbound-raw', v_t.storage_path);
    v_result := jsonb_build_object('ok', false, 'reject', 'too_many_attachments', 'delete_raw', true);
  elsif p_gmail_confirmation is not null then
    -- The caller only passes this for mail from Google's forwarding sender that passed DMARC.
    insert into public.forwarding_confirmations (feed_id, provider, code, confirm_url, requested_by, expires_at)
    values (v_t.feed_id, 'gmail', p_gmail_confirmation ->> 'code', p_gmail_confirmation ->> 'url',
            left(p_gmail_confirmation ->> 'requested_by', 320),
            now() + make_interval(days => (v_limits ->> 'confirmation_days')::int));
    perform private.trash('inbound-raw', v_t.storage_path);
    v_result := jsonb_build_object('ok', true, 'outcome', 'gmail_confirmation', 'delete_raw', true);
  elsif exists (select 1 from public.messages m where m.feed_id = v_t.feed_id
                and ((p_message_id_header is not null and m.message_id_header = left(p_message_id_header, 998))
                     or (p_body_sha256 is not null and m.sha256 = p_body_sha256))) then
    perform private.trash('inbound-raw', v_t.storage_path);
    v_result := jsonb_build_object('ok', true, 'outcome', 'duplicate', 'delete_raw', true);
  else
    if v_sender is not null then
      insert into public.sources (feed_id, sender_email, sender_domain)
      values (v_t.feed_id, left(v_sender, 320), left(split_part(v_sender, '@', 2), 253))
      on conflict (feed_id, lower(sender_email)) where sender_email is not null do nothing;
      select * into v_source from public.sources s
        where s.feed_id = v_t.feed_id and lower(s.sender_email) = v_sender;
    end if;

    if v_source.blocked then
      perform private.trash('inbound-raw', v_t.storage_path);
      v_result := jsonb_build_object('ok', true, 'outcome', 'blocked', 'delete_raw', true);
    else
      v_reason := case
        when p_dmarc = 'fail' then 'failed_authentication'
        when v_source.id is null or not v_source.trusted then 'new_sender'
      end;
      insert into public.messages (feed_id, source_id, message_id_header, sender, subject, storage_path, sha256,
                                   raw_bytes, attachment_count, auth_spf, auth_dkim, auth_dmarc, quarantine_reason)
      values (v_t.feed_id, v_source.id, left(p_message_id_header, 998), left(v_sender, 320), left(p_subject, 998),
              v_t.storage_path, p_body_sha256, p_raw_bytes, p_attachment_count, p_spf, p_dkim, p_dmarc, v_reason)
      on conflict do nothing
      returning id into v_message_id;
      if v_message_id is null then
        perform private.trash('inbound-raw', v_t.storage_path);
        v_result := jsonb_build_object('ok', true, 'outcome', 'duplicate', 'delete_raw', true);
      elsif v_reason is null then
        perform pgmq.send('process_message', jsonb_build_object('message_id', v_message_id));
        v_result := jsonb_build_object('ok', true, 'outcome', 'queued', 'message_id', v_message_id, 'delete_raw', false);
      else
        v_result := jsonb_build_object('ok', true, 'outcome', 'quarantined', 'reason', v_reason,
                                       'message_id', v_message_id, 'delete_raw', false);
      end if;
    end if;
  end if;

  update private.ingest_tickets set committed_at = now(), result = v_result where id = p_ticket;
  return v_result;
end;
$$;
revoke all on function public.ingest_commit(uuid, text, bigint, text, text, text, bytea, integer, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_commit(uuid, text, bigint, text, text, text, bytea, integer, text, text, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------- owner decisions
-- "Use emails from X for this feed?" Yes releases waiting mail into processing; No ignores it
-- and blocks future mail from X. Returns how many waiting messages it affected.
create function public.decide_sender(p_source_id uuid, p_trust boolean)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed_id uuid;
  v_count integer := 0;
  v_id uuid;
begin
  select feed_id into v_feed_id from public.sources where id = p_source_id;
  if v_feed_id is null or not private.is_feed_member(v_feed_id) then
    raise exception 'Sender not found.' using errcode = 'P0002';
  end if;
  update public.sources set trusted = p_trust, blocked = not p_trust where id = p_source_id;
  if p_trust then
    for v_id in
      update public.messages set quarantine_reason = null
      where source_id = p_source_id and quarantine_reason = 'new_sender' and status = 'received'
      returning id
    loop
      perform pgmq.send('process_message', jsonb_build_object('message_id', v_id));
      v_count := v_count + 1;
    end loop;
  else
    update public.messages set quarantine_reason = null, status = 'ignored'
      where source_id = p_source_id and quarantine_reason is not null and status = 'received';
    get diagnostics v_count = row_count;
  end if;
  return v_count;
end;
$$;
revoke all on function public.decide_sender(uuid, boolean) from public, anon;
grant execute on function public.decide_sender(uuid, boolean) to authenticated;

-- One message at a time (used for mail that failed authentication, and mail with no sender).
create function public.decide_message(p_message_id uuid, p_release boolean)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed_id uuid;
begin
  select feed_id into v_feed_id from public.messages
    where id = p_message_id and quarantine_reason is not null and status = 'received';
  if v_feed_id is null or not private.is_feed_member(v_feed_id) then
    raise exception 'Message not found, or already decided.' using errcode = 'P0002';
  end if;
  if p_release then
    update public.messages set quarantine_reason = null where id = p_message_id;
    perform pgmq.send('process_message', jsonb_build_object('message_id', p_message_id));
  else
    update public.messages set quarantine_reason = null, status = 'ignored' where id = p_message_id;
  end if;
  return true;
end;
$$;
revoke all on function public.decide_message(uuid, boolean) from public, anon;
grant execute on function public.decide_message(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- expiry (pg_cron, daily)
-- Deleting a message also queues its raw file for deletion through the Storage API.
create function private.messages_trash_raw()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.storage_path is not null then
    perform private.trash('inbound-raw', old.storage_path);
  end if;
  return old;
end;
$$;
revoke all on function private.messages_trash_raw() from public;
create trigger messages_trash_raw after delete on public.messages
  for each row execute function private.messages_trash_raw();

create function private.expire_intake()
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_messages integer;
  v_tickets integer;
  v_confirmations integer;
begin
  delete from public.messages where expires_at < now();
  get diagnostics v_messages = row_count;

  -- Uploads never committed (the Worker failed half way) are trashed after their ticket expires.
  -- Committed tickets' files belong to a message (or were already trashed at commit).
  with gone as (
    delete from private.ingest_tickets
    where (committed_at is null and expires_at < now() - interval '1 hour')
       or (committed_at is not null and committed_at < now() - interval '2 days')
    returning storage_path, committed_at
  ), trashed as (
    insert into private.storage_trash (bucket, path)
    select 'inbound-raw', storage_path from gone where committed_at is null
    on conflict do nothing
  )
  select count(*) into v_tickets from gone;

  delete from public.forwarding_confirmations where expires_at < now();
  get diagnostics v_confirmations = row_count;

  return jsonb_build_object('messages', v_messages, 'tickets', v_tickets, 'confirmations', v_confirmations);
end;
$$;
revoke all on function private.expire_intake() from public;

-- The Edge Function drains the trash in batches. Service role only.
create function public.claim_storage_trash(p_limit integer default 100)
returns table (id bigint, bucket text, path text)
language sql volatile security definer set search_path = ''
as $$
  select t.id, t.bucket, t.path from private.storage_trash t order by t.id limit least(greatest(p_limit, 1), 1000)
$$;
create function public.forget_storage_trash(p_ids bigint[])
returns integer
language sql volatile security definer set search_path = ''
as $$
  with gone as (delete from private.storage_trash where id = any(p_ids) returning 1) select count(*)::int from gone
$$;
revoke all on function public.claim_storage_trash(integer), public.forget_storage_trash(bigint[]) from public, anon, authenticated;
grant execute on function public.claim_storage_trash(integer), public.forget_storage_trash(bigint[]) to service_role;

-- Where the scheduler finds the Edge Functions. Set per environment by the deploy script
-- (and seed.sql locally). The key is the public anon key; storage-trash only ever deletes
-- files already queued for deletion, so a stranger calling it changes nothing.
create table private.app_settings (
  key text primary key check (key in ('functions_url', 'functions_key')),
  value text not null
);
alter table private.app_settings enable row level security;
revoke all on table private.app_settings from public, anon, authenticated;

create function private.call_edge_function(p_name text)
returns bigint
language plpgsql volatile set search_path = ''
as $$
declare
  v_url text := (select value from private.app_settings where key = 'functions_url');
  v_key text := (select value from private.app_settings where key = 'functions_key');
begin
  if v_url is null or v_key is null then
    raise notice 'call_edge_function(%): functions_url/functions_key not set; skipped', p_name;
    return null;
  end if;
  return net.http_post(
    url := v_url || '/' || p_name,
    headers := jsonb_build_object('authorization', 'Bearer ' || v_key, 'content-type', 'application/json'),
    body := '{}'::jsonb);
end;
$$;
revoke all on function private.call_edge_function(text) from public;

select cron.schedule('feedcal-expire-intake', '17 3 * * *',
  $$ select private.expire_intake(); select private.call_edge_function('storage-trash'); $$);

-- ---------------------------------------------------------------- raw storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inbound-raw', 'inbound-raw', false, 20 * 1024 * 1024, array['message/rfc822'])
on conflict (id) do nothing;
-- No storage.objects policies for this bucket: only the service role (which bypasses RLS) and
-- one-time signed upload URLs can touch it.
