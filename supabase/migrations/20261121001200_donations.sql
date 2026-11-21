-- Phase 15: Buy Me a Coffee donations (D36). The bmc-webhook Edge Function verifies the signature
-- and calls record_bmc_event. Supporters are keyed by a hash of their email; linking to a Feedcal
-- account happens only when the person asks. Perks are thank-yous: a badge and an optional listing.

create table private.bmc_events (
  event_id bigint primary key,
  type text not null check (char_length(type) <= 60),
  live_mode boolean not null,
  outcome text not null,
  received_at timestamptz not null default now()
);
alter table private.bmc_events enable row level security;
revoke all on table private.bmc_events from public, anon, authenticated;

-- Replaces the Phase 2 placeholder (never written to), keeping the link column name `user_id`
-- that purge_account_data already clears, and keeping direct reads closed to users (test 001).
drop table public.supporters;
alter table public.profiles add column supporter_since timestamptz;
create table public.supporters (
  id uuid primary key default gen_random_uuid(),
  supporter_hash bytea not null unique check (octet_length(supporter_hash) = 32),
  display_name text check (display_name is null or char_length(display_name) <= 80),
  donations integer not null default 0 check (donations >= 0),
  total_cents bigint not null default 0,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  member boolean not null default false,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  user_id uuid unique references public.profiles (id) on delete set null,  -- linked only on opt-in
  list_publicly boolean not null default false
);
alter table public.supporters enable row level security;
revoke all on table public.supporters from anon, authenticated;

-- The signed-in person's own supporter status (no direct table access).
create function public.my_supporter_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('linked', s.id is not null, 'member', coalesce(s.member, false), 'donations', coalesce(s.donations, 0),
    'list_publicly', coalesce(s.list_publicly, false), 'since', p.supporter_since)
  from public.profiles p left join public.supporters s on s.user_id = p.id where p.id = (select auth.uid())
$$;
revoke all on function public.my_supporter_status() from public, anon;
grant execute on function public.my_supporter_status() to authenticated;


create function private.email_hash(p_email text)
returns bytea
language sql immutable set search_path = ''
as $$ select extensions.digest(convert_to(lower(trim(p_email)), 'UTF8'), 'sha256') $$;
revoke all on function private.email_hash(text) from public;

-- Idempotent: each Buy Me a Coffee event_id counts once, however often it's delivered.
-- Dashboard test events (live_mode = false) are recorded but only change supporters when
-- p_accept_test is true (staging).
create function public.record_bmc_event(p_event_id bigint, p_type text, p_live boolean, p_email text, p_name text,
                                        p_amount_cents bigint, p_currency text, p_accept_test boolean default false)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_outcome text;
  v_hash bytea;
begin
  if exists (select 1 from private.bmc_events where event_id = p_event_id) then
    return 'duplicate';
  end if;
  v_outcome := case
    when not p_live and not p_accept_test then 'test_ignored'
    when p_type not in ('donation.created', 'donation.refunded', 'membership.started', 'membership.cancelled',
                        'recurring_donation.started', 'recurring_donation.cancelled') then 'ignored'
    when p_email is null or p_email !~ '@' then 'no_supporter'
    else 'applied' end;
  insert into private.bmc_events (event_id, type, live_mode, outcome) values (p_event_id, left(p_type, 60), p_live, v_outcome);
  if v_outcome <> 'applied' then
    return v_outcome;
  end if;
  v_hash := private.email_hash(p_email);
  insert into public.supporters (supporter_hash, display_name, currency) values (v_hash, nullif(left(trim(p_name), 80), ''), upper(left(p_currency, 3)))
  on conflict (supporter_hash) do update set display_name = coalesce(excluded.display_name, public.supporters.display_name), last_at = now();
  update public.supporters set
    donations = donations + case when p_type = 'donation.created' then 1 else 0 end,
    total_cents = total_cents + case when p_type = 'donation.created' then coalesce(p_amount_cents, 0)
                                     when p_type = 'donation.refunded' then -coalesce(p_amount_cents, 0) else 0 end,
    member = case when p_type in ('membership.started', 'recurring_donation.started') then true
                  when p_type in ('membership.cancelled', 'recurring_donation.cancelled') then false else member end,
    last_at = now()
  where supporter_hash = v_hash;
  return 'applied';
end;
$$;
revoke all on function public.record_bmc_event(bigint, text, boolean, text, text, bigint, text, boolean) from public, anon, authenticated;
grant execute on function public.record_bmc_event(bigint, text, boolean, text, text, bigint, text, boolean) to service_role;

-- Opt-in: "I support Feedcal on Buy Me a Coffee" links the supporter record whose email matches
-- the signed-in account's email, gives the badge, and sends a thank-you once.
create function public.link_supporter()
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  v_id uuid;
begin
  select email into v_email from auth.users where id = v_uid;
  update public.supporters set user_id = v_uid
    where supporter_hash = private.email_hash(v_email) and (user_id is null or user_id = v_uid)
    returning id into v_id;
  if v_id is null then
    return false;
  end if;
  update public.profiles set supporter_since = coalesce(supporter_since, now()) where id = v_uid;
  perform private.enqueue_email(v_uid, 'supporter_thanks', 'supporter_thanks:' || v_uid, '{}'::jsonb);
  return true;
end;
$$;

create function public.set_supporter_listing(p_list boolean)
returns boolean
language sql volatile security definer set search_path = ''
as $$ update public.supporters set list_publicly = p_list where user_id = (select auth.uid()) returning list_publicly $$;

revoke all on function public.link_supporter(), public.set_supporter_listing(boolean) from public, anon;
grant execute on function public.link_supporter(), public.set_supporter_listing(boolean) to authenticated;

-- The optional public thank-you list: only people who chose to be listed, by the name they gave.
create function public.public_supporters()
returns table (display_name text, since date)
language sql stable security definer set search_path = ''
as $$
  select coalesce(s.display_name, 'A supporter'), s.first_at::date from public.supporters s
  where s.list_publicly and s.user_id is not null order by s.first_at limit 500
$$;
revoke all on function public.public_supporters() from public;
grant execute on function public.public_supporters() to anon, authenticated;

-- Thank-you emails go through the Phase 12 outbox.
alter table private.email_outbox drop constraint email_outbox_kind_check;
alter table private.email_outbox add constraint email_outbox_kind_check check (kind in ('weekly_digest', 'report', 'stale_nudge', 'milestone', 'supporter_thanks'));

-- The thank-you is sent once, but its unsubscribe link must still work (it changes nothing else).
create or replace function public.unsubscribe(p_user uuid, p_kind text, p_token text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_kind not in ('weekly_digest', 'report', 'stale_nudge', 'milestone', 'supporter_thanks', 'all') or p_token is null
     or p_token <> private.unsubscribe_token(p_user, p_kind) then
    return false;
  end if;
  insert into public.notification_settings (user_id) values (p_user) on conflict do nothing;
  update public.notification_settings set
    weekly_digest = weekly_digest and p_kind not in ('weekly_digest', 'all'),
    instant_reports = instant_reports and p_kind not in ('report', 'all'),
    staleness = staleness and p_kind not in ('stale_nudge', 'all'),
    milestones = milestones and p_kind not in ('milestone', 'all'),
    updated_at = now()
  where user_id = p_user;
  return true;
end;
$$;
