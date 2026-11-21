-- Phase 2: email intake tables. Only a feed's owners and editors can read these.
-- Rows are written by server-side jobs using the service role (which bypasses RLS).

-- ---------------------------------------------------------------- sources
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  sender_email text check (sender_email is null or char_length(sender_email) <= 320),
  sender_domain text check (sender_domain is null or char_length(sender_domain) <= 253),
  attachment_rule jsonb,
  trusted boolean not null default false,
  created_at timestamptz not null default now(),
  check (sender_email is not null or sender_domain is not null)
);
create index sources_feed_idx on public.sources (feed_id);
create unique index sources_feed_sender_idx on public.sources (feed_id, lower(sender_email)) where sender_email is not null;
alter table public.sources enable row level security;
revoke all on table public.sources from anon, authenticated;
grant select, delete on table public.sources to authenticated;
grant insert (feed_id, sender_email, sender_domain, attachment_rule, trusted) on table public.sources to authenticated;
grant update (sender_email, sender_domain, attachment_rule, trusted) on table public.sources to authenticated;

create policy sources_member_all on public.sources
  for all to authenticated
  using (private.is_feed_member(feed_id)) with check (private.is_feed_member(feed_id));

-- ---------------------------------------------------------------- messages
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  source_id uuid references public.sources (id) on delete set null,
  message_id_header text check (message_id_header is null or char_length(message_id_header) <= 998),
  sender text check (sender is null or char_length(sender) <= 320),
  subject text check (subject is null or char_length(subject) <= 998),
  received_at timestamptz not null default now(),
  storage_path text,
  sha256 bytea check (sha256 is null or octet_length(sha256) = 32),
  status text not null default 'received'
    check (status in ('received', 'parsed', 'extracted', 'needs_review', 'ignored', 'failed')),
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now()
);
-- The same forwarded email arriving twice is stored once (idempotency, rule 8).
create unique index messages_feed_msgid_idx on public.messages (feed_id, message_id_header) where message_id_header is not null;
create index messages_feed_received_idx on public.messages (feed_id, received_at desc);
create index messages_expires_idx on public.messages (expires_at);
alter table public.messages enable row level security;
revoke all on table public.messages from anon, authenticated;
grant select, delete on table public.messages to authenticated;

create policy messages_member_select on public.messages
  for select to authenticated using (private.is_feed_member(feed_id));
create policy messages_member_delete on public.messages
  for delete to authenticated using (private.is_feed_member(feed_id));

-- ---------------------------------------------------------------- attachments
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  filename text check (filename is null or char_length(filename) <= 255),
  mime text check (mime is null or char_length(mime) <= 255),
  bytes bigint check (bytes is null or bytes >= 0),
  pages integer check (pages is null or pages >= 0),
  sha256 bytea check (sha256 is null or octet_length(sha256) = 32),
  chosen boolean not null default false,
  storage_path text,
  status text not null default 'pending'
    check (status in ('pending', 'skipped', 'text_layer', 'transcribed', 'failed')),
  created_at timestamptz not null default now()
);
create index attachments_message_idx on public.attachments (message_id);
alter table public.attachments enable row level security;
revoke all on table public.attachments from anon, authenticated;
grant select on table public.attachments to authenticated;
-- "This one has the schedule" (Phase 8) is the only field an owner/editor changes directly.
grant update (chosen) on table public.attachments to authenticated;

create function private.attachment_feed_id(p_message_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$ select m.feed_id from public.messages m where m.id = p_message_id; $$;
revoke all on function private.attachment_feed_id(uuid) from public;
grant execute on function private.attachment_feed_id(uuid) to authenticated, service_role;

create policy attachments_member_select on public.attachments
  for select to authenticated using (private.is_feed_member(private.attachment_feed_id(message_id)));
create policy attachments_member_update on public.attachments
  for update to authenticated
  using (private.is_feed_member(private.attachment_feed_id(message_id)))
  with check (private.is_feed_member(private.attachment_feed_id(message_id)));

-- ---------------------------------------------------------------- attachment_pages [Rev 2]
-- One row per page. text holds either the PDF text layer or the vision model's verbatim
-- transcription; Phase 9 checks evidence quotes against it.
create table public.attachment_pages (
  attachment_id uuid not null references public.attachments (id) on delete cascade,
  page_index integer not null check (page_index >= 0),
  text text,
  text_source text not null check (text_source in ('text_layer', 'transcription')),
  image_path text,
  created_at timestamptz not null default now(),
  primary key (attachment_id, page_index)
);
alter table public.attachment_pages enable row level security;
revoke all on table public.attachment_pages from anon, authenticated;
grant select on table public.attachment_pages to authenticated;

create function private.page_feed_id(p_attachment_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select m.feed_id from public.attachments a join public.messages m on m.id = a.message_id
  where a.id = p_attachment_id;
$$;
revoke all on function private.page_feed_id(uuid) from public;
grant execute on function private.page_feed_id(uuid) to authenticated, service_role;

create policy attachment_pages_member_select on public.attachment_pages
  for select to authenticated using (private.is_feed_member(private.page_feed_id(attachment_id)));
