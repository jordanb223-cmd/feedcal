-- Phase 14: moderation, abuse and safety (D35).

-- ---------------------------------------------------------------- admins (second factor required)
create table public.admins (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on table public.admins from anon, authenticated;

-- An admin is in the table AND signed in with a second factor in this session (aal2).
create function private.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
     and coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
$$;
revoke all on function private.is_admin() from public;
grant execute on function private.is_admin() to authenticated;

-- What the console needs to decide which screen to show (no second factor needed to ask).
create function public.admin_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'is_admin', exists (select 1 from public.admins a where a.user_id = (select auth.uid())),
    'aal', coalesce((select auth.jwt() ->> 'aal'), 'aal1'))
$$;
revoke all on function public.admin_status() from public, anon;
grant execute on function public.admin_status() to authenticated;

create table public.admin_audit (
  id bigint generated always as identity primary key,
  admin_id uuid references public.profiles (id) on delete set null,
  action text not null check (action in ('hide_feed', 'unhide_feed', 'suspend_user', 'unsuspend_user', 'verify_feed', 'unverify_feed', 'dismiss_report', 'clear_flag')),
  target_type text not null check (target_type in ('feed', 'user', 'report', 'flag')),
  target_id uuid not null,
  reason text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default now()
);
alter table public.admin_audit enable row level security;
revoke all on table public.admin_audit from anon, authenticated;
grant select on table public.admin_audit to authenticated;
create policy admin_audit_admin_select on public.admin_audit for select to authenticated using (private.is_admin());

create function private.audit(p_action text, p_type text, p_id uuid, p_reason text)
returns void
language sql volatile set search_path = ''
as $$ insert into public.admin_audit (admin_id, action, target_type, target_id, reason) values ((select auth.uid()), p_action, p_type, p_id, left(p_reason, 500)) $$;
revoke all on function private.audit(text, text, uuid, text) from public;

-- ---------------------------------------------------------------- hidden feeds, suspended users
alter table public.feeds add column hidden_at timestamptz, add column hidden_reason text check (hidden_reason is null or char_length(hidden_reason) <= 500);
alter table public.profiles add column suspended_at timestamptz;
grant select (hidden_at) on table public.feeds to authenticated;

-- A hidden feed vanishes for everyone else at once: page, calendar link, directory, sitemap, events.
alter policy feeds_anon_select_public on public.feeds using (visibility = 'public' and hidden_at is null);
create or replace function private.feed_is_public(p_feed_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.feeds f where f.id = p_feed_id and f.visibility = 'public' and f.hidden_at is null) $$;

create or replace function public.public_feed_page(p_slug text, p_limit integer default 50)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with f as (
    select fd.id, fd.name, fd.slug, fd.description, fd.category, fd.zip_code, fd.visibility, fd.verified,
           fd.last_updated_at, fd.feed_token_secret_id, p.display_name as organizer_name
    from public.feeds fd
    left join public.profiles p on p.id = fd.owner_id and p.deleted_at is null
    where fd.slug = p_slug and fd.visibility in ('public', 'unlisted') and fd.hidden_at is null
  )
  select jsonb_build_object(
    'feed', jsonb_build_object(
      'id', f.id, 'name', f.name, 'slug', f.slug, 'description', f.description,
      'category', f.category, 'zip_code', f.zip_code, 'visibility', f.visibility, 'verified', f.verified,
      'last_updated_at', f.last_updated_at, 'organizer_name', f.organizer_name,
      'area', (select z.city || ', ' || z.state from public.zip_codes z where z.zip = f.zip_code),
      'subscribers_at_least', private.subscriber_estimate(f.id, current_date - 7, current_date),
      'may_be_out_of_date', f.last_updated_at < now() - interval '90 days',
      'feed_token', (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.id = f.feed_token_secret_id)
    ),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'uid', e.uid, 'title', e.title, 'description', e.description,
        'location', e.location, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
        'all_day', e.all_day, 'timezone', e.timezone, 'rrule', e.rrule, 'status', e.status
      ) order by e.starts_at)
      from (
        select * from public.events ev
        where ev.feed_id = f.id and ev.published and ev.status <> 'cancelled'
          and coalesce(ev.ends_at, ev.starts_at) >= now()
        order by ev.starts_at
        limit least(greatest(coalesce(p_limit, 50), 1), 200)
      ) e
    ), '[]'::jsonb)
  )
  from f;
$$;

create or replace function public.feed_calendar(p_token text, p_client_ip text default null,
                                                p_user_agent text default null, p_ua_family text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed public.feeds%rowtype;
  v_salt bytea;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    return null;
  end if;
  select * into v_feed from public.feeds where feed_token_hash = private.token_hash(p_token) and hidden_at is null;
  if not found then
    return null;
  end if;

  if p_client_ip is not null then
    insert into private.fetch_salts (day) values (current_date) on conflict (day) do nothing;
    select salt into v_salt from private.fetch_salts where day = current_date;
    insert into public.feed_fetch_daily (feed_id, day, client_hash, user_agent_family)
    values (v_feed.id, current_date,
            sha256(v_salt || convert_to(left(p_client_ip, 64) || '|' || left(coalesce(p_user_agent, ''), 512), 'UTF8')),
            left(p_ua_family, 40))
    on conflict do nothing;
    delete from private.fetch_salts where day < current_date - 2;
  end if;

  return jsonb_build_object(
    'feed', jsonb_build_object(
      'id', v_feed.id, 'name', v_feed.name, 'slug', v_feed.slug, 'description', v_feed.description,
      'visibility', v_feed.visibility, 'last_updated_at', v_feed.last_updated_at),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'uid', e.uid, 'title', e.title, 'description', e.description,
        'location', e.location, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'all_day', e.all_day,
        'timezone', e.timezone, 'rrule', e.rrule, 'exdates', to_jsonb(e.exdates), 'status', e.status, 'sequence', e.sequence,
        'created_at', e.created_at, 'updated_at', e.updated_at,
        'source', (select s.sender_domain from public.messages m join public.sources s on s.id = m.source_id
                   where m.id = e.source_message_id)
      ) order by e.starts_at)
      from (
        select * from public.events ev
        where ev.feed_id = v_feed.id and ev.published
          and (ev.status <> 'cancelled' or ev.updated_at > now() - interval '30 days')
        order by ev.starts_at
        limit 2000
      ) e
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------- reports about a whole feed
create table public.feed_reports (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  kind text not null check (kind in ('spam', 'wrong_info', 'inappropriate', 'impersonation', 'privacy')),
  details text check (details is null or char_length(details) <= 2000),
  reporter_hash bytea check (reporter_hash is null or octet_length(reporter_hash) = 32),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now()
);
create index feed_reports_open_idx on public.feed_reports (created_at) where status = 'open';
alter table public.feed_reports enable row level security;
revoke all on table public.feed_reports from anon, authenticated;
grant select on table public.feed_reports to authenticated;
create policy feed_reports_admin_select on public.feed_reports for select to authenticated using (private.is_admin());

create function public.submit_feed_report(p_slug text, p_kind text, p_details text default null, p_client_ip text default null)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed uuid;
  v_hash bytea;
begin
  if p_kind not in ('spam', 'wrong_info', 'inappropriate', 'impersonation', 'privacy') then return 'bad_kind'; end if;
  select id into v_feed from public.feeds where slug = left(p_slug, 100) and visibility in ('public', 'unlisted') and hidden_at is null;
  if v_feed is null then return 'not_found'; end if;
  if p_client_ip is not null then
    v_hash := extensions.digest((select key from private.notification_key) || convert_to(left(p_client_ip, 64), 'UTF8'), 'sha256');
    delete from private.report_limits where at < now() - interval '1 hour';
    if (select count(*) from private.report_limits where reporter_hash = v_hash) >= 10 then return 'rate_limited'; end if;
    insert into private.report_limits (reporter_hash) values (v_hash);
  end if;
  insert into public.feed_reports (feed_id, kind, details, reporter_hash) values (v_feed, p_kind, nullif(left(trim(p_details), 2000), ''), v_hash);
  return 'ok';
end;
$$;
revoke all on function public.submit_feed_report(text, text, text, text) from public;
grant execute on function public.submit_feed_report(text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------- automated screening
create table public.moderation_flags (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  reasons text[] not null,
  excerpt text check (excerpt is null or char_length(excerpt) <= 300),
  status text not null default 'open' check (status in ('open', 'cleared', 'actioned')),
  created_at timestamptz not null default now()
);
create index moderation_flags_open_idx on public.moderation_flags (feed_id) where status = 'open';
alter table public.moderation_flags enable row level security;
revoke all on table public.moderation_flags from anon, authenticated;
grant select on table public.moderation_flags to authenticated;
create policy moderation_flags_admin_select on public.moderation_flags for select to authenticated using (private.is_admin());

-- Cheap, explainable checks on text that would be public.
create function private.screen_text(p_text text)
returns text[]
language plpgsql immutable set search_path = ''
as $$
declare
  t text := lower(coalesce(p_text, ''));
  r text[] := '{}';
begin
  if t ~ '(bit\.ly|tinyurl\.com|t\.co/|goo\.gl|is\.gd|cutt\.ly|rebrand\.ly|ow\.ly)' then r := array_append(r, 'link_shortener'); end if;
  if (select count(*) from regexp_matches(t, 'https?://', 'g')) > 3 then r := array_append(r, 'many_links'); end if;
  if t ~ '\m(casino|viagra|cialis|crypto ?currency|bitcoin|forex|payday loan|onlyfans|xxx|porn)' then r := array_append(r, 'spam_words'); end if;
  if t ~ '\m(kill yourself|kys)\M' then r := array_append(r, 'abuse'); end if;
  if length(regexp_replace(coalesce(p_text, ''), '[^A-Z]', '', 'g')) > 40
     and length(regexp_replace(coalesce(p_text, ''), '[^A-Z]', '', 'g')) > 0.6 * length(regexp_replace(coalesce(p_text, ''), '[^A-Za-z]', '', 'g')) then
    r := array_append(r, 'shouting');
  end if;
  return r;
end;
$$;
revoke all on function private.screen_text(text) from public;

-- ---------------------------------------------------------------- new-account limits, public listing
create function private.feeds_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_profile public.profiles%rowtype;
  v_reasons text[];
begin
  -- Operators (service role, no signed-in user) and admins aren't limited.
  if v_uid is null or exists (select 1 from public.admins where user_id = v_uid) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.hidden_at is not null and new.visibility is distinct from old.visibility then
    raise exception 'This feed is hidden while it''s reviewed, so its visibility can''t change.' using errcode = '42501';
  end if;
  select * into v_profile from public.profiles where id = v_uid;
  if v_profile.suspended_at is not null then
    raise exception 'This account is suspended.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and v_profile.created_at > now() - interval '30 days' and (select count(*) from public.feeds where owner_id = v_uid) >= 3 then
    raise exception 'New accounts can have up to 3 feeds for their first 30 days. Contact us if you need more.' using errcode = '42501';
  end if;
  if new.visibility = 'public' and (tg_op = 'INSERT' or old.visibility <> 'public') then
    if v_profile.created_at > now() - interval '7 days' then
      raise exception 'Public listing opens 7 days after you join. Until then, share it with "anyone with the link".' using errcode = '42501';
    end if;
    if not exists (select 1 from auth.users u where u.id = v_uid and u.email_confirmed_at is not null) then
      raise exception 'Please confirm your email before listing a feed publicly.' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' or not exists (select 1 from public.events e where e.feed_id = new.id and e.published and e.status <> 'cancelled') then
      raise exception 'A feed needs at least one published event before it can be listed publicly.' using errcode = '42501';
    end if;
    if exists (select 1 from public.moderation_flags f where f.feed_id = new.id and f.status = 'open') then
      raise exception 'This feed is waiting for a quick review before it can be listed publicly.' using errcode = '42501';
    end if;
  end if;
  -- Screen text that is or will be public; flags go to the admin queue.
  if new.visibility in ('public', 'unlisted') and (tg_op = 'INSERT' or new.name is distinct from old.name or new.description is distinct from old.description
      or new.visibility is distinct from old.visibility) then
    v_reasons := private.screen_text(coalesce(new.name, '') || ' ' || coalesce(new.description, ''));
    if cardinality(v_reasons) > 0 and tg_op = 'UPDATE' then
      insert into public.moderation_flags (feed_id, reasons, excerpt) values (new.id, v_reasons, left(new.name || ': ' || coalesce(new.description, ''), 300));
      if new.visibility = 'public' then
        raise exception 'This feed is waiting for a quick review before it can be listed publicly.' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.feeds_guard() from public;
create trigger feeds_guard before insert or update of visibility, name, description on public.feeds
  for each row execute function private.feeds_guard();

-- New feeds' text is screened after insert (the id exists then).
create function private.feeds_screen_new()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_reasons text[] := private.screen_text(coalesce(new.name, '') || ' ' || coalesce(new.description, ''));
begin
  if cardinality(v_reasons) > 0 and (select auth.uid()) is not null then
    insert into public.moderation_flags (feed_id, reasons, excerpt) values (new.id, v_reasons, left(new.name || ': ' || coalesce(new.description, ''), 300));
  end if;
  return new;
end;
$$;
revoke all on function private.feeds_screen_new() from public;
create trigger feeds_screen_new after insert on public.feeds for each row execute function private.feeds_screen_new();

-- ---------------------------------------------------------------- verification badge
-- Automatic when the owner's email domain is an organisation's (not a free mail provider) AND
-- that same domain is a trusted sender for the feed. Otherwise an admin decides.
create function public.verify_feed_by_domain(p_feed_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_domain text;
begin
  if private.feed_role(p_feed_id) is distinct from 'owner' then
    raise exception 'Only the owner can ask for verification.' using errcode = '42501';
  end if;
  select lower(split_part(u.email, '@', 2)) into v_domain from auth.users u where u.id = (select auth.uid());
  if v_domain is null or v_domain in ('gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com',
      'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'yandex.com', 'msn.com', 'comcast.net', 'att.net', 'sbcglobal.net') then
    return false;
  end if;
  if not exists (select 1 from public.sources s where s.feed_id = p_feed_id and s.trusted and lower(s.sender_domain) = v_domain) then
    return false;
  end if;
  update public.feeds set verified = true where id = p_feed_id;
  return true;
end;
$$;
revoke all on function public.verify_feed_by_domain(uuid) from public, anon;
grant execute on function public.verify_feed_by_domain(uuid) to authenticated;

-- ---------------------------------------------------------------- admin actions (aal2 required)
create function private.require_admin()
returns void
language plpgsql stable set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Admins only, with a second factor.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_admin() from public;

-- One click from the queue: hide the feed, close its open reports and flags, and audit it.
create function public.admin_hide_feed(p_feed_id uuid, p_reason text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.require_admin();
  update public.feeds set hidden_at = coalesce(hidden_at, now()), hidden_reason = left(p_reason, 500) where id = p_feed_id;
  update public.feed_reports set status = 'actioned' where feed_id = p_feed_id and status = 'open';
  update public.moderation_flags set status = 'actioned' where feed_id = p_feed_id and status = 'open';
  perform private.audit('hide_feed', 'feed', p_feed_id, p_reason);
end;
$$;

create function public.admin_unhide_feed(p_feed_id uuid, p_reason text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.require_admin();
  update public.feeds set hidden_at = null, hidden_reason = null where id = p_feed_id;
  perform private.audit('unhide_feed', 'feed', p_feed_id, p_reason);
end;
$$;

-- Suspending signs the person out everywhere (banned in Auth) and hides all their feeds.
create function public.admin_suspend_user(p_user_id uuid, p_reason text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_user_id = (select auth.uid()) then
    raise exception 'You can''t suspend yourself.' using errcode = 'P0001';
  end if;
  update public.profiles set suspended_at = now() where id = p_user_id;
  update auth.users set banned_until = 'infinity' where id = p_user_id;
  delete from auth.sessions where user_id = p_user_id;
  update public.feeds set hidden_at = coalesce(hidden_at, now()), hidden_reason = coalesce(hidden_reason, 'owner suspended') where owner_id = p_user_id;
  perform private.audit('suspend_user', 'user', p_user_id, p_reason);
end;
$$;

create function public.admin_unsuspend_user(p_user_id uuid, p_reason text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.require_admin();
  update public.profiles set suspended_at = null where id = p_user_id;
  update auth.users set banned_until = null where id = p_user_id;
  update public.feeds set hidden_at = null, hidden_reason = null where owner_id = p_user_id and hidden_reason = 'owner suspended';
  perform private.audit('unsuspend_user', 'user', p_user_id, p_reason);
end;
$$;

create function public.admin_set_verified(p_feed_id uuid, p_verified boolean, p_reason text default null)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.require_admin();
  update public.feeds set verified = p_verified where id = p_feed_id;
  perform private.audit(case when p_verified then 'verify_feed' else 'unverify_feed' end, 'feed', p_feed_id, p_reason);
end;
$$;

create function public.admin_dismiss(p_kind text, p_id uuid, p_reason text default null)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_kind = 'report' then
    update public.feed_reports set status = 'dismissed' where id = p_id;
    perform private.audit('dismiss_report', 'report', p_id, p_reason);
  else
    update public.moderation_flags set status = 'cleared' where id = p_id;
    perform private.audit('clear_flag', 'flag', p_id, p_reason);
  end if;
end;
$$;

-- The queue, oldest first, with what an admin needs to decide.
create function public.admin_queue()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_admin();
  return jsonb_build_object(
    'reports', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'details', r.details, 'created_at', r.created_at,
        'feed', jsonb_build_object('id', f.id, 'name', f.name, 'slug', f.slug, 'visibility', f.visibility, 'hidden', f.hidden_at is not null, 'owner_id', f.owner_id))
        order by r.created_at) from public.feed_reports r join public.feeds f on f.id = r.feed_id where r.status = 'open'), '[]'::jsonb),
    'flags', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'reasons', to_jsonb(m.reasons), 'excerpt', m.excerpt, 'created_at', m.created_at,
        'feed', jsonb_build_object('id', f.id, 'name', f.name, 'slug', f.slug, 'visibility', f.visibility, 'hidden', f.hidden_at is not null, 'owner_id', f.owner_id))
        order by m.created_at) from public.moderation_flags m join public.feeds f on f.id = m.feed_id where m.status = 'open'), '[]'::jsonb),
    'audit', coalesce((select jsonb_agg(a order by a.id desc) from (select id, action, target_type, target_id, reason, created_at from public.admin_audit order by id desc limit 50) a), '[]'::jsonb));
end;
$$;

revoke all on function public.admin_hide_feed(uuid, text), public.admin_unhide_feed(uuid, text), public.admin_suspend_user(uuid, text),
  public.admin_unsuspend_user(uuid, text), public.admin_set_verified(uuid, boolean, text), public.admin_dismiss(text, uuid, text), public.admin_queue() from public, anon;
grant execute on function public.admin_hide_feed(uuid, text), public.admin_unhide_feed(uuid, text), public.admin_suspend_user(uuid, text),
  public.admin_unsuspend_user(uuid, text), public.admin_set_verified(uuid, boolean, text), public.admin_dismiss(text, uuid, text), public.admin_queue() to authenticated;
