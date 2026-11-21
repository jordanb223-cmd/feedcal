-- App-side limit on sign-in emails (readiness item 13): at most 5 per address and 20 per IP
-- per rolling hour. Supabase Auth has its own limits; this one is ours, so we can explain it.
-- Addresses and IPs are stored only as salted sha256 hashes, and rows older than an hour are
-- deleted on every call.

create table private.login_salt (
  id boolean primary key default true check (id),
  salt bytea not null default extensions.gen_random_bytes(32)
);
insert into private.login_salt default values;

create table private.login_attempts (
  id bigint generated always as identity primary key,
  email_hash bytea not null,
  ip_hash bytea,
  at timestamptz not null default now()
);
create index login_attempts_email_idx on private.login_attempts (email_hash, at);
create index login_attempts_ip_idx on private.login_attempts (ip_hash, at) where ip_hash is not null;
create index login_attempts_at_idx on private.login_attempts (at);

alter table private.login_salt enable row level security;
alter table private.login_attempts enable row level security;
revoke all on table private.login_salt, private.login_attempts from public, anon, authenticated;

-- Limits, defined once.
create function private.login_limits()
returns jsonb
language sql immutable set search_path = ''
as $$ select jsonb_build_object('per_email_per_hour', 5, 'per_ip_per_hour', 20) $$;
revoke all on function private.login_limits() from public;

-- Records one attempt and returns true, or returns false (and records nothing) when the address
-- or the IP is already at its limit. A refused attempt isn't counted, so waiting always works.
-- Anyone can call this: the worst a direct caller can do is use up an address's 5 attempts,
-- which they could also do by submitting the form. It never sends email itself.
create function public.login_attempt_allowed(p_email text, p_client_ip text default null)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_salt bytea;
  v_email bytea;
  v_ip bytea;
  v_limits jsonb := private.login_limits();
begin
  if p_email is null or char_length(p_email) = 0 or char_length(p_email) > 320 then
    return false;
  end if;
  select salt into v_salt from private.login_salt;
  v_email := extensions.digest(v_salt || convert_to(lower(trim(p_email)), 'UTF8'), 'sha256');
  if p_client_ip is not null and char_length(p_client_ip) between 1 and 64 then
    v_ip := extensions.digest(v_salt || convert_to(p_client_ip, 'UTF8'), 'sha256');
  end if;

  delete from private.login_attempts where at < now() - interval '1 hour';

  if (select count(*) from private.login_attempts where email_hash = v_email)
       >= (v_limits ->> 'per_email_per_hour')::int then
    return false;
  end if;
  if v_ip is not null and (select count(*) from private.login_attempts where ip_hash = v_ip)
       >= (v_limits ->> 'per_ip_per_hour')::int then
    return false;
  end if;

  insert into private.login_attempts (email_hash, ip_hash) values (v_email, v_ip);
  return true;
end;
$$;
revoke all on function public.login_attempt_allowed(text, text) from public;
grant execute on function public.login_attempt_allowed(text, text) to anon, authenticated;
