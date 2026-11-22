-- D51 (2026-11-21): a visitor's address is trusted only when the request comes from Feedcal's own
-- web server. Found in the post-launch security check: five public functions took p_client_ip from
-- the caller, so anyone calling the API directly could invent addresses to inflate a calendar's
-- follower count (confirmed on the local stack: 25 forged calls, count 0 → 25) or step around the
-- report, search and sign-in limits.
--
-- The proof is a server-only key: the deploy creates it in Vault (name 'rpc_proxy_key') and gives
-- it to the web server, which sends it in the x-feedcal-proxy header on every database call.
-- Browsers never see it. With no key configured (local development), behaviour is unchanged.
-- Each public function keeps its name and inputs; the original moves to private and a thin
-- wrapper decides which address to pass on.

create function private.proxy_ok()
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_key text;
  v_hdr text;
begin
  select ds.decrypted_secret into v_key from vault.decrypted_secrets ds where ds.name = 'rpc_proxy_key';
  if v_key is null then
    return true;  -- not configured: local development and tests
  end if;
  begin
    v_hdr := nullif(current_setting('request.headers', true), '')::json ->> 'x-feedcal-proxy';
  exception when others then
    v_hdr := null;
  end;
  return v_hdr is not null
     and extensions.digest(convert_to(v_hdr, 'UTF8'), 'sha256') = extensions.digest(convert_to(v_key, 'UTF8'), 'sha256');
end;
$$;
revoke all on function private.proxy_ok() from public;

-- Move the originals out of the API, unchanged.
alter function public.feed_calendar_guarded(text, text, text, text) set schema private;
alter function private.feed_calendar_guarded(text, text, text, text) rename to feed_calendar_guarded_inner;
alter function public.rate_check(text, text) set schema private;
alter function private.rate_check(text, text) rename to rate_check_inner;
alter function public.login_attempt_allowed(text, text) set schema private;
alter function private.login_attempt_allowed(text, text) rename to login_attempt_allowed_inner;
alter function public.submit_report(text, text, text, text) set schema private;
alter function private.submit_report(text, text, text, text) rename to submit_report_inner;
alter function public.submit_feed_report(text, text, text, text) set schema private;
alter function private.submit_feed_report(text, text, text, text) rename to submit_feed_report_inner;
revoke all on function private.feed_calendar_guarded_inner(text, text, text, text), private.rate_check_inner(text, text),
  private.login_attempt_allowed_inner(text, text), private.submit_report_inner(text, text, text, text),
  private.submit_feed_report_inner(text, text, text, text) from public, anon, authenticated;

-- The calendar: an unproven address isn't recorded, so it can't move the follower count.
create function public.feed_calendar_guarded(p_token text, p_client_ip text default null,
                                             p_user_agent text default null, p_ua_family text default null)
returns jsonb
language sql volatile security definer set search_path = ''
as $$ select private.feed_calendar_guarded_inner(p_token, case when private.proxy_ok() then p_client_ip end, p_user_agent, p_ua_family) $$;

-- Limits: every unproven caller shares one bucket, so inventing addresses gains nothing.
create function public.rate_check(p_bucket text, p_client_ip text)
returns boolean
language sql volatile security definer set search_path = ''
as $$ select private.rate_check_inner(p_bucket, case when private.proxy_ok() then p_client_ip else 'unproven' end) $$;

create function public.login_attempt_allowed(p_email text, p_client_ip text default null)
returns boolean
language sql volatile security definer set search_path = ''
as $$ select private.login_attempt_allowed_inner(p_email, case when private.proxy_ok() then p_client_ip else 'unproven' end) $$;

create function public.submit_report(p_event_uid text, p_kind text, p_details text default null, p_client_ip text default null)
returns text
language sql volatile security definer set search_path = ''
as $$ select private.submit_report_inner(p_event_uid, p_kind, p_details, case when private.proxy_ok() then p_client_ip else 'unproven' end) $$;

create function public.submit_feed_report(p_slug text, p_kind text, p_details text default null, p_client_ip text default null)
returns text
language sql volatile security definer set search_path = ''
as $$ select private.submit_feed_report_inner(p_slug, p_kind, p_details, case when private.proxy_ok() then p_client_ip else 'unproven' end) $$;

revoke all on function public.feed_calendar_guarded(text, text, text, text), public.rate_check(text, text),
  public.login_attempt_allowed(text, text), public.submit_report(text, text, text, text),
  public.submit_feed_report(text, text, text, text) from public;
grant execute on function public.feed_calendar_guarded(text, text, text, text) to anon, authenticated, service_role;
grant execute on function public.rate_check(text, text), public.login_attempt_allowed(text, text),
  public.submit_report(text, text, text, text), public.submit_feed_report(text, text, text, text) to anon, authenticated;

-- The unguarded calendar function skips the miss limits and records addresses as given; only the
-- guarded one is meant for the API. (Database-owner callers, like the tests, are unaffected.)
revoke execute on function public.feed_calendar(text, text, text, text) from anon, authenticated;
