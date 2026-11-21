-- Phase 16: security hardening and privacy (D37).
--   1. Keys out of plain tables: the unsubscribe HMAC key and the sign-in salt move into Vault,
--      so a database dump alone can't forge unsubscribe links or reverse the salted hashes.
--   2. A generic rate limiter, a guard on feed-token misses, and rate checks for the public
--      search and subscribe-tap endpoints.
--   3. Privacy: a full export of your own data; full deletion now also removes a linked
--      supporter record, and account purges run every day.
--   4. Advisor clean-up: indexes for foreign keys, a primary key for report_limits.

-- ---------------------------------------------------------------- 1. keys into Vault
-- The existing values move unchanged, so unsubscribe links already sent keep working.
select vault.create_secret(encode(key, 'hex'), 'feedcal_notification_key', 'HMAC key for unsubscribe links and report rate limits (D33, D37)')
from private.notification_key;
select vault.create_secret(encode(salt, 'hex'), 'feedcal_login_salt', 'Salt for hashed sign-in limits (D37)')
from private.login_salt;
drop table private.notification_key;
drop table private.login_salt;

-- Same names and columns as the old tables, so every function that reads them is unchanged.
create view private.notification_key as
  select decode(ds.decrypted_secret, 'hex') as key from vault.decrypted_secrets ds where ds.name = 'feedcal_notification_key';
create view private.login_salt as
  select decode(ds.decrypted_secret, 'hex') as salt from vault.decrypted_secrets ds where ds.name = 'feedcal_login_salt';
revoke all on private.notification_key, private.login_salt from public, anon, authenticated;

-- ---------------------------------------------------------------- 2. rate limits
create table private.rate_hits (
  id bigint generated always as identity primary key,
  bucket text not null,
  key_hash bytea not null,
  at timestamptz not null default now()
);
create index rate_hits_lookup_idx on private.rate_hits (bucket, key_hash, at);
create index rate_hits_at_idx on private.rate_hits (at);
alter table private.rate_hits enable row level security;
revoke all on table private.rate_hits from public, anon, authenticated;

-- One definition of every public limit (bucket -> max hits per window).
create function private.rate_limits()
returns jsonb
language sql immutable set search_path = ''
as $$ select '{
  "feed_miss":   {"max": 30,  "seconds": 600},
  "search":      {"max": 60,  "seconds": 60},
  "click":       {"max": 30,  "seconds": 60}
}'::jsonb $$;
revoke all on function private.rate_limits() from public;

-- True when this key is under its bucket's limit. p_record = true counts this hit.
-- Keys are salted hashes (the Vault-held notification key), never raw IPs.
create function private.rate_ok(p_bucket text, p_key text, p_record boolean default true)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_limit jsonb := private.rate_limits() -> p_bucket;
  v_hash bytea;
begin
  if v_limit is null then
    raise exception 'unknown rate bucket %', p_bucket;
  end if;
  if p_key is null or char_length(p_key) = 0 then
    return true;  -- no client address (local development): nothing to count against
  end if;
  v_hash := extensions.digest((select key from private.notification_key) || convert_to(p_bucket || ':' || left(p_key, 64), 'UTF8'), 'sha256');
  delete from private.rate_hits where bucket = p_bucket and key_hash = v_hash
    and at < now() - make_interval(secs => (v_limit ->> 'seconds')::int);
  if (select count(*) from private.rate_hits where bucket = p_bucket and key_hash = v_hash) >= (v_limit ->> 'max')::int then
    return false;
  end if;
  if p_record then
    insert into private.rate_hits (bucket, key_hash) values (p_bucket, v_hash);
  end if;
  return true;
end;
$$;
revoke all on function private.rate_ok(text, text, boolean) from public;

-- For the web app's public pages (directory search, subscribe taps). Only these buckets.
create function public.rate_check(p_bucket text, p_client_ip text)
returns boolean
language sql volatile security definer set search_path = ''
as $$ select case when p_bucket in ('search', 'click') then private.rate_ok(p_bucket, p_client_ip) else false end $$;
revoke all on function public.rate_check(text, text) from public;
grant execute on function public.rate_check(text, text) to anon, authenticated;

-- The calendar endpoint. Tokens are 256-bit, so guessing can't work; this also stops an
-- address that keeps asking for tokens that don't exist (30 misses in 10 minutes) from
-- trying more for a while. Google's and Microsoft's fetchers are exempt: they fetch for many
-- people from shared addresses, and old links after "make a new link" would otherwise lock
-- whole providers out. (A caller can claim to be Google; see THREAT-MODEL T2.)
create function public.feed_calendar_guarded(p_token text, p_client_ip text default null,
                                             p_user_agent text default null, p_ua_family text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_exempt boolean := coalesce(p_ua_family, '') in ('google', 'outlook');
  v_result jsonb;
begin
  if not v_exempt and not private.rate_ok('feed_miss', p_client_ip, false) then
    raise exception 'Too many requests for calendars that do not exist. Try again later.' using errcode = 'P0429';
  end if;
  v_result := public.feed_calendar(p_token, p_client_ip, p_user_agent, p_ua_family);
  if v_result is null and not v_exempt then
    perform private.rate_ok('feed_miss', p_client_ip, true);
  end if;
  return v_result;
end;
$$;
revoke all on function public.feed_calendar_guarded(text, text, text, text) from public;
grant execute on function public.feed_calendar_guarded(text, text, text, text) to anon, authenticated, service_role;
-- The web app calls only the guarded version. feed_calendar stays callable through the API:
-- a direct caller chooses its own p_client_ip anyway, so revoking it would protect nothing
-- (THREAT-MODEL T2: the protection is the 256-bit token).

create function private.purge_rate_hits()
returns void
language sql volatile set search_path = ''
as $$ delete from private.rate_hits where at < now() - interval '1 hour' $$;
select cron.schedule('feedcal-purge-rate-hits', '7 * * * *', $$ select private.purge_rate_hits() $$);

-- ---------------------------------------------------------------- 3. privacy
-- Everything Feedcal holds about the signed-in person, as one JSON document. Secrets and
-- internal hashes are left out (they identify nothing to the person and could be misused).
create function public.export_my_data()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with me as (select (select auth.uid()) as uid)
  select jsonb_build_object(
    'exported_at', now(),
    'format', 'feedcal-export-1',
    'account', (select jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at)
                from auth.users u, me where u.id = me.uid),
    'profile', (select to_jsonb(p) from public.profiles p, me where p.id = me.uid),
    'notification_settings', (select to_jsonb(s) - 'user_id' from public.notification_settings s, me where s.user_id = me.uid),
    'supporter', public.my_supporter_status(),
    'feeds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'feed', to_jsonb(f) - 'feed_token_hash' - 'feed_token_secret_id',
        'role', fe.role,
        'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.starts_at) from public.events e where e.feed_id = f.id), '[]'::jsonb),
        'senders', coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from public.sources s where s.feed_id = f.id), '[]'::jsonb),
        'emails', coalesce((select jsonb_agg(to_jsonb(m) - 'sha256' - 'storage_path' order by m.created_at) from public.messages m where m.feed_id = f.id), '[]'::jsonb)
      ) order by f.created_at)
      from public.feeds f join public.feed_editors fe on fe.feed_id = f.id, me where fe.user_id = me.uid), '[]'::jsonb)
  )
$$;
revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;

-- Full deletion: as before (D18), and a linked supporter record is now deleted, not just unlinked.
create or replace function public.purge_account_data(p_user_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed record;
  v_heir uuid;
  v_transferred integer := 0;
  v_deleted integer := 0;
begin
  for v_feed in select id from public.feeds where owner_id = p_user_id for update loop
    select fe.user_id into v_heir from public.feed_editors fe
      where fe.feed_id = v_feed.id and fe.role = 'editor'
      order by fe.created_at, fe.user_id limit 1;
    if v_heir is null then
      delete from public.feeds where id = v_feed.id;
      v_deleted := v_deleted + 1;
    else
      delete from public.feed_editors where feed_id = v_feed.id and user_id = p_user_id;
      update public.feed_editors set role = 'owner' where feed_id = v_feed.id and user_id = v_heir;
      update public.feeds set owner_id = v_heir where id = v_feed.id;
      v_transferred := v_transferred + 1;
    end if;
  end loop;

  delete from public.feed_editors where user_id = p_user_id;
  update public.event_revisions set actor = 'system' where actor = 'user:' || p_user_id::text;
  delete from public.supporters where user_id = p_user_id;
  update public.profiles set display_name = null where id = p_user_id;

  return jsonb_build_object('feeds_transferred', v_transferred, 'feeds_deleted', v_deleted);
end;
$$;

-- Account purges run daily (they were run by hand until now; SETUP §6 said so). The function
-- only ever purges accounts already past their grace period, so the scheduler's anon-key call
-- is enough, as for storage-trash.
select cron.schedule('feedcal-delete-accounts', '41 4 * * *', $$ select private.call_edge_function('delete-accounts') $$);

-- Retention for the two tables nothing cleared before (privacy page, D37):
--   feed fetch counts: 400 days (the per-device hash can't be linked back once its day's salt
--   is deleted, after 2 days); sent or failed email payloads (which can hold a subscriber's note):
--   emptied after 30 days. The rows stay so a once-only email is never sent twice.
create function private.apply_retention()
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_fetch integer;
  v_outbox integer;
begin
  delete from public.feed_fetch_daily where day < current_date - 400;
  get diagnostics v_fetch = row_count;
  update private.email_outbox set payload = '{}'::jsonb, last_error = null
    where state in ('sent', 'failed') and created_at < now() - interval '30 days' and payload <> '{}'::jsonb;
  get diagnostics v_outbox = row_count;
  return jsonb_build_object('fetch_rows_deleted', v_fetch, 'outbox_payloads_cleared', v_outbox);
end;
$$;
revoke all on function private.apply_retention() from public;
select cron.schedule('feedcal-retention', '23 5 * * *', $$ select private.apply_retention() $$);

-- ---------------------------------------------------------------- 4. advisor clean-up
alter table private.report_limits add column id bigint generated always as identity primary key;
create index email_outbox_user_idx on private.email_outbox (user_id);
create index admin_audit_admin_idx on public.admin_audit (admin_id);
create index event_candidates_attachment_idx on public.event_candidates (attachment_id);
create index event_candidates_decided_by_idx on public.event_candidates (decided_by);
create index event_candidates_event_idx on public.event_candidates (event_id);
create index feed_reports_feed_idx on public.feed_reports (feed_id);
create index messages_source_idx on public.messages (source_id);
create index reports_event_idx on public.reports (event_id);
create index undo_log_feed_idx on public.undo_log (feed_id);
create index undo_log_user_idx on public.undo_log (user_id);
