-- Phase 2: profiles, feeds, feed_editors, feed tokens [Rev 1], unlisted slugs [Rev 3].
-- RLS is enabled on every table in the same migration that creates it.
-- Default Supabase grants are revoked; each role gets only the privileges listed here.

create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Helpers that RLS policies call live in a schema PostgREST does not expose.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.profiles enable row level security;
revoke all on table public.profiles from anon, authenticated;
grant select, update (display_name) on table public.profiles to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ---------------------------------------------------------------- feeds
create table public.feeds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$'),
  description text check (description is null or char_length(description) <= 2000),
  category text check (category is null or char_length(category) between 1 and 40),
  zip_code text check (zip_code is null or zip_code ~ '^[0-9]{5}$'),
  location extensions.geography(Point, 4326),
  visibility text not null default 'private' check (visibility in ('public', 'unlisted', 'private')),
  feed_token_hash bytea not null unique check (octet_length(feed_token_hash) = 32),
  feed_token_secret_id uuid not null,
  intake_address text unique,
  auto_publish_threshold numeric(3, 2) check (auto_publish_threshold is null or auto_publish_threshold between 0 and 1),
  search tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(category, '')), 'C')
  ) stored,
  last_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index feeds_search_idx on public.feeds using gin (search);
create index feeds_location_idx on public.feeds using gist (location);
create index feeds_owner_idx on public.feeds (owner_id);
alter table public.feeds enable row level security;

-- ---------------------------------------------------------------- feed_editors
create table public.feed_editors (
  feed_id uuid not null references public.feeds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (feed_id, user_id)
);
create unique index feed_editors_one_owner on public.feed_editors (feed_id) where role = 'owner';
create index feed_editors_user_idx on public.feed_editors (user_id);
alter table public.feed_editors enable row level security;

-- ---------------------------------------------------------------- helpers
-- The caller's role on a feed: 'owner', 'editor' or null. SECURITY DEFINER so policies
-- on feeds and feed_editors can call it without recursing through each other's RLS.
create function private.feed_role(p_feed_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select fe.role from public.feed_editors fe
  where fe.feed_id = p_feed_id and fe.user_id = (select auth.uid());
$$;

create function private.is_feed_member(p_feed_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.feed_editors fe
    where fe.feed_id = p_feed_id and fe.user_id = (select auth.uid())
  );
$$;

create function private.feed_is_public(p_feed_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.feeds f where f.id = p_feed_id and f.visibility = 'public');
$$;

revoke all on function private.feed_role(uuid), private.is_feed_member(uuid), private.feed_is_public(uuid) from public;
grant execute on function private.feed_role(uuid), private.is_feed_member(uuid), private.feed_is_public(uuid)
  to anon, authenticated, service_role;

-- 43-character URL-safe token from 32 random bytes.
create function private.new_token()
returns text
language sql volatile set search_path = ''
as $$
  select rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
$$;

create function private.token_hash(p_token text)
returns bytea
language sql immutable set search_path = ''
as $$
  select sha256(convert_to(p_token, 'UTF8'));
$$;

-- 8 random characters from [a-z0-9].
create function private.random_suffix()
returns text
language sql volatile set search_path = ''
as $$
  select string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', (get_byte(b, i) % 36) + 1, 1), '')
  from (select extensions.gen_random_bytes(8) as b) r, generate_series(0, 7) as i;
$$;

revoke all on function private.new_token(), private.token_hash(text), private.random_suffix() from public;
grant execute on function private.token_hash(text) to service_role;

-- ---------------------------------------------------------------- feed triggers
-- Before insert: mint the feed token, store its hash and a Vault copy [Rev 1].
create function private.feeds_before_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_token text := private.new_token();
begin
  new.feed_token_hash := private.token_hash(v_token);
  new.feed_token_secret_id := vault.create_secret(v_token, 'feed_token:' || new.id::text, 'Feedcal feed token');
  return new;
end;
$$;
create trigger feeds_before_insert before insert on public.feeds
  for each row execute function private.feeds_before_insert();

-- Unlisted slugs get a random suffix so they can't be guessed [Rev 3].
create function private.feeds_unlisted_slug()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.visibility = 'unlisted'
     and (tg_op = 'INSERT' or old.visibility <> 'unlisted' or new.slug <> old.slug) then
    new.slug := left(new.slug, 71) || '-' || private.random_suffix();
  end if;
  return new;
end;
$$;
create trigger feeds_unlisted_slug before insert or update of slug, visibility on public.feeds
  for each row execute function private.feeds_unlisted_slug();

-- After insert: the owner becomes the feed's 'owner' editor row.
create function private.feeds_after_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.feed_editors (feed_id, user_id, role) values (new.id, new.owner_id, 'owner');
  return null;
end;
$$;
create trigger feeds_after_insert after insert on public.feeds
  for each row execute function private.feeds_after_insert();

-- After delete: remove the token's Vault secret.
create function private.feeds_after_delete()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.feed_token_secret_id;
  return null;
end;
$$;
create trigger feeds_after_delete after delete on public.feeds
  for each row execute function private.feeds_after_delete();

revoke all on function private.feeds_before_insert(), private.feeds_unlisted_slug(),
  private.feeds_after_insert(), private.feeds_after_delete() from public;

-- ---------------------------------------------------------------- feed grants and policies
-- Token columns are never granted to anon or authenticated; only the SECURITY DEFINER
-- token functions below touch them. Anon sees only public-safe columns of public feeds.
revoke all on table public.feeds from anon, authenticated;
grant select (id, owner_id, name, slug, description, category, zip_code, location, visibility,
  search, last_updated_at, created_at) on table public.feeds to anon;
grant select (id, owner_id, name, slug, description, category, zip_code, location, visibility,
  intake_address, auto_publish_threshold, search, last_updated_at, created_at) on table public.feeds to authenticated;
grant insert (name, slug, description, category, zip_code, location, visibility, auto_publish_threshold)
  on table public.feeds to authenticated;
grant update (name, slug, description, category, zip_code, location, visibility, auto_publish_threshold)
  on table public.feeds to authenticated;
grant delete on table public.feeds to authenticated;

create policy feeds_anon_select_public on public.feeds
  for select to anon using (visibility = 'public');
-- owner_id check lets INSERT ... RETURNING see the row before the after-insert trigger adds feed_editors.
create policy feeds_member_select on public.feeds
  for select to authenticated using (owner_id = (select auth.uid()) or private.is_feed_member(id));
create policy feeds_insert_own on public.feeds
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy feeds_owner_update on public.feeds
  for update to authenticated using (private.feed_role(id) = 'owner') with check (private.feed_role(id) = 'owner');
create policy feeds_owner_delete on public.feeds
  for delete to authenticated using (private.feed_role(id) = 'owner');

revoke all on table public.feed_editors from anon, authenticated;
grant select on table public.feed_editors to authenticated;
grant insert (feed_id, user_id, role), delete on table public.feed_editors to authenticated;

create policy feed_editors_member_select on public.feed_editors
  for select to authenticated using (private.is_feed_member(feed_id));
-- Owners add and remove editors. The owner row itself can't be added or removed this way.
create policy feed_editors_owner_insert on public.feed_editors
  for insert to authenticated with check (role = 'editor' and private.feed_role(feed_id) = 'owner');
create policy feed_editors_owner_delete on public.feed_editors
  for delete to authenticated using (role = 'editor' and private.feed_role(feed_id) = 'owner');

-- ---------------------------------------------------------------- token functions [Rev 1]
-- Rotate: new token, new hash, Vault copy overwritten. The old link stops working. Owner only.
create function public.rotate_feed_token(p_feed_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_token text := private.new_token();
  v_secret uuid;
begin
  if private.feed_role(p_feed_id) is distinct from 'owner' then
    raise exception 'Only the feed owner can make a new feed link.' using errcode = '42501';
  end if;
  update public.feeds set feed_token_hash = private.token_hash(v_token)
    where id = p_feed_id returning feed_token_secret_id into v_secret;
  perform vault.update_secret(v_secret, v_token);
  return v_token;
end;
$$;

-- Read the current token back so the owner can see the link again. Owners and editors only.
create function public.get_feed_token(p_feed_id uuid)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_token text;
begin
  if not private.is_feed_member(p_feed_id) then
    raise exception 'Only the feed''s owner or editors can see its link.' using errcode = '42501';
  end if;
  select ds.decrypted_secret into v_token
    from public.feeds f join vault.decrypted_secrets ds on ds.id = f.feed_token_secret_id
    where f.id = p_feed_id;
  return v_token;
end;
$$;

revoke all on function public.rotate_feed_token(uuid), public.get_feed_token(uuid) from public, anon;
grant execute on function public.rotate_feed_token(uuid), public.get_feed_token(uuid) to authenticated;
