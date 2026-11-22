-- D63: a contact and bug-report form. Messages are stored for 90 days and emailed to every admin
-- (public.admins). The sender's address is never required; if given, it becomes the email's
-- Reply-To so the admin can answer. Limited to 5 messages an hour per address; requests that
-- can't prove they came through the website share one bucket (D51), like the report forms.

create table private.contact_messages (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('bug', 'question', 'privacy', 'other')),
  message text not null check (char_length(message) between 1 and 4000),
  reply_to text check (reply_to is null or (char_length(reply_to) <= 254 and reply_to ~* '^[^\s@<>",;:()\\\[\]]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$')),
  page text check (page is null or char_length(page) <= 500),
  signed_in boolean not null default false,  -- not linked to an account, so it isn't data "about you" beyond what you typed
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days'
);
alter table private.contact_messages enable row level security;
revoke all on table private.contact_messages from public, anon, authenticated;

create or replace function private.rate_limits()
returns jsonb
language sql immutable set search_path = ''
as $$ select '{
  "feed_miss":   {"max": 30,  "seconds": 600},
  "search":      {"max": 60,  "seconds": 60},
  "click":       {"max": 30,  "seconds": 60},
  "import":      {"max": 10,  "seconds": 86400},
  "contact":     {"max": 5,   "seconds": 3600}
}'::jsonb $$;

alter table private.email_outbox drop constraint email_outbox_kind_check;
alter table private.email_outbox add constraint email_outbox_kind_check
  check (kind in ('weekly_digest', 'report', 'stale_nudge', 'milestone', 'supporter_thanks', 'ops_alert', 'gmail_reconnect', 'contact'));

create function private.submit_contact_inner(p_kind text, p_message text, p_reply_to text, p_page text, p_client_ip text)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_message text := btrim(coalesce(p_message, ''));
  v_reply text := nullif(lower(btrim(coalesce(p_reply_to, ''))), '');
  v_page text := nullif(btrim(left(coalesce(p_page, ''), 500)), '');
  v_id uuid;
begin
  if coalesce(p_kind, '') not in ('bug', 'question', 'privacy', 'other') or char_length(v_message) = 0 then return 'invalid'; end if;
  if char_length(v_message) > 4000 then return 'too_long'; end if;
  if v_reply is not null and (char_length(v_reply) > 254 or v_reply !~* '^[^\s@<>",;:()\\\[\]]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$') then
    return 'bad_email';
  end if;
  if not private.rate_ok('contact', coalesce(p_client_ip, 'unknown')) then return 'too_many'; end if;
  insert into private.contact_messages (kind, message, reply_to, page, signed_in)
  values (p_kind, v_message, v_reply, v_page, (select auth.uid()) is not null)
  returning id into v_id;
  perform private.enqueue_email(a.user_id, 'contact', 'contact:' || v_id || ':' || a.user_id,
    jsonb_build_object('kind', p_kind, 'message', v_message, 'reply_to', v_reply, 'page', v_page, 'signed_in', (select auth.uid()) is not null))
  from public.admins a;
  return 'ok';
end;
$$;
revoke all on function private.submit_contact_inner(text, text, text, text, text) from public, anon, authenticated;

create function public.submit_contact(p_kind text, p_message text, p_reply_to text default null, p_page text default null, p_client_ip text default null)
returns text
language sql volatile security definer set search_path = ''
as $$ select private.submit_contact_inner(p_kind, p_message, p_reply_to, p_page, case when private.proxy_ok() then p_client_ip else 'unproven' end) $$;
revoke all on function public.submit_contact(text, text, text, text, text) from public;
grant execute on function public.submit_contact(text, text, text, text, text) to anon, authenticated;

-- Daily: messages older than 90 days are deleted.
create function private.purge_contact_messages()
returns integer language sql volatile security definer set search_path = '' as $$
  with gone as (delete from private.contact_messages where expires_at < now() returning 1) select count(*)::int from gone
$$;
revoke all on function private.purge_contact_messages() from public, anon, authenticated;
select cron.schedule('feedcal-purge-contact', '41 4 * * *', $$ select private.purge_contact_messages() $$);
