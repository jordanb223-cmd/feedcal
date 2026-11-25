-- D89 (owner's decision): a chat on one event, which the calendar's organizer switches on.
-- Followers post without a name; each gets a made-up one ("Blue Heron") that stays the same for
-- that event. Text only, no links, short, rate-limited. The organizer sees everything and can
-- remove any message; three reports from different places hide a message; the chat closes when the
-- event is over, and the organizer can switch it off at any time.
create table public.event_chats (
  event_id uuid primary key references public.events (id) on delete cascade,
  feed_id uuid not null references public.feeds (id) on delete cascade,
  enabled boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid references public.profiles (id) on delete set null
);
alter table public.event_chats enable row level security;
revoke all on table public.event_chats from anon, authenticated;
grant select on table public.event_chats to authenticated;
create policy event_chats_member_select on public.event_chats
  for select to authenticated using (private.is_feed_member(feed_id));

create table public.event_chat_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  feed_id uuid not null references public.feeds (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 300),
  author_hash bytea not null check (octet_length(author_hash) = 32),   -- limits and the made-up name only
  author_name text not null check (char_length(author_name) between 1 and 40),
  is_organizer boolean not null default false,
  status text not null default 'shown' check (status in ('shown', 'removed')),
  created_at timestamptz not null default now()
);
create index event_chat_messages_event_idx on public.event_chat_messages (event_id, created_at);
alter table public.event_chat_messages enable row level security;
revoke all on table public.event_chat_messages from anon, authenticated;
-- Everything goes through the functions below; nobody reads or writes these tables directly.

create table private.event_chat_reports (
  message_id uuid not null references public.event_chat_messages (id) on delete cascade,
  reporter_hash bytea not null check (octet_length(reporter_hash) = 32),
  at timestamptz not null default now(),
  primary key (message_id, reporter_hash)
);
alter table private.event_chat_reports enable row level security;
revoke all on table private.event_chat_reports from public, anon, authenticated;

-- Open: switched on, the event is on the calendar, and it isn't over. An event with no end time
-- counts as an hour long (D84); an all-day event lasts through its last day.
create function private.chat_is_open(e public.events)
returns boolean
language sql stable set search_path = ''
as $$
  select e.published and e.status <> 'cancelled'
    and coalesce((select c.enabled from public.event_chats c where c.event_id = e.id), false)
    and exists (select 1 from public.feeds f where f.id = e.feed_id and f.hidden_at is null and f.delete_requested_at is null)
    and (coalesce(e.ends_at, e.starts_at)
           + case when e.all_day then interval '1 day' when e.ends_at is null then interval '1 hour' else interval '0' end >= now()
         or exists (select 1 from unnest(e.occurrences) o where o >= now()));
$$;
revoke all on function private.chat_is_open(public.events) from public, anon, authenticated;

create function private.chat_name(p_event_id uuid, p_hash bytea)
returns text
language sql immutable set search_path = ''
as $$
  with d as (select extensions.digest(convert_to(p_event_id::text, 'UTF8') || p_hash, 'sha256') as h)
  select (array['Blue','Green','Amber','Silver','Coral','Golden','Violet','Scarlet','Teal','Ivory','Copper','Indigo','Maple','Misty','Sunny','Quiet'])[get_byte(h, 0) % 16 + 1]
      || ' '
      || (array['Heron','Otter','Robin','Fox','Owl','Finch','Badger','Wren','Hare','Swan','Lynx','Dove','Seal','Crane','Moth','Bee'])[get_byte(h, 1) % 16 + 1]
  from d;
$$;
revoke all on function private.chat_name(uuid, bytea) from public, anon, authenticated;

-- Post a message. Returns 'ok', or why not.
create function private.chat_post_inner(p_event_uid text, p_body text, p_client_ip text)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_body text := nullif(left(trim(regexp_replace(regexp_replace(coalesce(p_body, ''), '[\u0000-\u0008\u000B\u000C\u000E-\u001F]', '', 'g'), '\s+', ' ', 'g')), 300), '');
  v_member boolean;
  v_hash bytea;
begin
  if v_body is null then
    return 'empty';
  end if;
  select * into e from public.events where uid = left(p_event_uid, 200);
  if not found or not private.chat_is_open(e) then
    return 'closed';
  end if;
  -- Text only: nothing that looks like a link or an address to go to.
  if v_body ~* '(https?://|www\.|[a-z0-9-]+\.(com|net|org|io|co|me|ly|gg|app|info|xyz|ru|cn|link|site)(\W|$))' then
    return 'no_links';
  end if;
  v_member := private.is_feed_member(e.feed_id);
  v_hash := extensions.digest((select key from private.notification_key)
              || convert_to(case when v_member then 'member:' || (select auth.uid())::text else left(coalesce(p_client_ip, 'unknown'), 64) end, 'UTF8'), 'sha256');
  if not v_member then
    if exists (select 1 from public.event_chat_messages m where m.event_id = e.id and m.author_hash = v_hash and m.created_at > now() - interval '10 seconds') then
      return 'slow_down';
    end if;
    if (select count(*) from public.event_chat_messages m where m.author_hash = v_hash and m.created_at > now() - interval '1 hour') >= 30 then
      return 'rate_limited';
    end if;
  end if;
  if (select count(*) from public.event_chat_messages m where m.event_id = e.id) >= 500 then
    return 'full';
  end if;
  insert into public.event_chat_messages (event_id, feed_id, body, author_hash, author_name, is_organizer)
  values (e.id, e.feed_id, v_body, v_hash, case when v_member then 'Organizer' else private.chat_name(e.id, v_hash) end, v_member);
  return 'ok';
end;
$$;
revoke all on function private.chat_post_inner(text, text, text) from public, anon, authenticated;

create function public.chat_post(p_event_uid text, p_body text, p_client_ip text default null)
returns text
language sql volatile security definer set search_path = ''
as $$ select private.chat_post_inner(p_event_uid, p_body, case when private.proxy_ok() then p_client_ip else 'unproven' end) $$;
revoke all on function public.chat_post(text, text, text) from public;
grant execute on function public.chat_post(text, text, text) to anon, authenticated;

-- The chat page: the event, whether the chat is open, and the last 100 messages that are showing.
-- Nothing at all unless the organizer has switched this event's chat on at some point. A private
-- calendar's event gives no title or calendar name.
create function public.chat_page(p_event_uid text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'event', jsonb_build_object(
      'title', case when f.visibility in ('public', 'unlisted') then e.title end,
      'calendar', case when f.visibility in ('public', 'unlisted') then f.name end,
      'starts_at', e.starts_at, 'ends_at', e.ends_at, 'all_day', e.all_day, 'timezone', e.timezone),
    'open', private.chat_is_open(e),
    'on', c.enabled,
    'moderator', private.is_feed_member(e.feed_id),
    'messages', case when c.enabled then coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.author_name, 'body', m.body, 'at', m.created_at, 'organizer', m.is_organizer) order by m.created_at)
      from (select * from public.event_chat_messages x where x.event_id = e.id and x.status = 'shown' order by x.created_at desc limit 100) m
    ), '[]'::jsonb) else '[]'::jsonb end)
  from public.events e
  join public.feeds f on f.id = e.feed_id
  join public.event_chats c on c.event_id = e.id
  where e.uid = left(p_event_uid, 200) and e.published and e.status <> 'cancelled'
    and f.hidden_at is null and f.delete_requested_at is null;
$$;
revoke all on function public.chat_page(text) from public;
grant execute on function public.chat_page(text) to anon, authenticated;

-- A reader reports a message. Three reports from different places hide it.
create function private.chat_report_inner(p_message_id uuid, p_client_ip text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_hash bytea := extensions.digest((select key from private.notification_key) || convert_to(left(coalesce(p_client_ip, 'unknown'), 64), 'UTF8'), 'sha256');
begin
  if not exists (select 1 from public.event_chat_messages m where m.id = p_message_id and m.status = 'shown' and not m.is_organizer) then
    return false;
  end if;
  insert into private.event_chat_reports (message_id, reporter_hash) values (p_message_id, v_hash) on conflict do nothing;
  if (select count(*) from private.event_chat_reports r where r.message_id = p_message_id) >= 3 then
    update public.event_chat_messages set status = 'removed' where id = p_message_id;
  end if;
  return true;
end;
$$;
revoke all on function private.chat_report_inner(uuid, text) from public, anon, authenticated;

create function public.chat_report(p_message_id uuid, p_client_ip text default null)
returns boolean
language sql volatile security definer set search_path = ''
as $$ select private.chat_report_inner(p_message_id, case when private.proxy_ok() then p_client_ip else 'unproven' end) $$;
revoke all on function public.chat_report(uuid, text) from public;
grant execute on function public.chat_report(uuid, text) to anon, authenticated;

-- The organizer (or an editor) removes a message.
create function public.chat_remove(p_message_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  n integer;
begin
  update public.event_chat_messages m set status = 'removed'
  where m.id = p_message_id and m.status = 'shown' and private.is_feed_member(m.feed_id);
  get diagnostics n = row_count;
  return n = 1;
end;
$$;
revoke all on function public.chat_remove(uuid) from public, anon;
grant execute on function public.chat_remove(uuid) to authenticated;

-- The organizer (or an editor) switches an event's chat on or off.
create function public.set_event_chat(p_event_id uuid, p_on boolean)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed uuid;
begin
  select e.feed_id into v_feed from public.events e where e.id = p_event_id;
  if v_feed is null or not private.is_feed_member(v_feed) then
    return false;
  end if;
  insert into public.event_chats (event_id, feed_id, enabled, changed_by) values (p_event_id, v_feed, coalesce(p_on, false), (select auth.uid()))
  on conflict (event_id) do update set enabled = excluded.enabled, changed_at = now(), changed_by = excluded.changed_by;
  return true;
end;
$$;
revoke all on function public.set_event_chat(uuid, boolean) from public, anon;
grant execute on function public.set_event_chat(uuid, boolean) to authenticated;

-- The calendar file learns which events have an open chat, so those events can link to it.
do $$
declare
  f record;
  n integer := 0;
  a text := '''id'', e.id, ''uid'', e.uid, ''title'', e.title, ''description'', e.description,';
begin
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname in ('public', 'private') and p.prokind = 'f' and p.proname = 'feed_calendar'
      and position(a in pg_get_functiondef(p.oid)) > 0
  loop
    execute replace(f.def, a, a || ' ''chat'', coalesce((select private.chat_is_open(x) from public.events x where x.id = e.id), false),');
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception 'event chat: expected to change feed_calendar once, changed % functions', n;
  end if;
end;
$$;
