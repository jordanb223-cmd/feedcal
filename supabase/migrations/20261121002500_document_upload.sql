-- D61: organizers upload a PDF, Word file, photo or text file to a calendar from the website.
-- The browser sends the file straight to private storage with a one-time link (Cloudflare's free
-- plan allows 10 ms of CPU per request, too little to pass 10 MB through the website), then the
-- upload-file Edge Function checks the stored file and calls upload_finish, which creates the same
-- message + attachment an email would and queues triage. Limits: 10 MB, 20 uploads a day each.

alter table public.messages add column uploaded_by uuid references public.profiles (id) on delete set null;
comment on column public.messages.uploaded_by is 'D61: set when the message is a file uploaded on the website (no sender).';

create table private.upload_tickets (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  filename text not null check (char_length(filename) between 1 and 255),
  mime text not null,
  declared_bytes integer not null check (declared_bytes between 1 and 10485760),
  path text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at timestamptz
);
create index upload_tickets_user_day_idx on private.upload_tickets (user_id, created_at);
alter table private.upload_tickets enable row level security;
revoke all on table private.upload_tickets from public, anon, authenticated;

create function private.upload_limits()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('max_bytes', 10485760, 'per_user_per_day', 20, 'ticket_minutes', 15,
    'types', jsonb_build_object(
      'application/pdf', 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx',
      'image/jpeg', 'jpg|jpeg', 'image/png', 'png', 'image/webp', 'webp', 'image/gif', 'gif',
      'text/plain', 'txt', 'text/csv', 'csv', 'text/calendar', 'ics'))
$$;

-- Called by the upload-file function (service role) after it has verified the user's session.
create function public.upload_start(p_user uuid, p_feed uuid, p_filename text, p_mime text, p_bytes integer)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_limits jsonb := private.upload_limits();
  v_name text := regexp_replace(coalesce(p_filename, ''), '[\x00-\x1f\x7f/\\]', '', 'g');
  v_ext text := lower(substring(v_name from '\.([A-Za-z0-9]{1,5})$'));
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  if not exists (select 1 from public.feed_editors where feed_id = p_feed and user_id = p_user) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if char_length(v_name) = 0 or char_length(v_name) > 255 then return jsonb_build_object('ok', false, 'reason', 'bad_name'); end if;
  if not (v_limits -> 'types') ? coalesce(p_mime, '') or v_ext is null
     or not v_ext ~ ('^(' || (v_limits -> 'types' ->> p_mime) || ')$') then
    return jsonb_build_object('ok', false, 'reason', 'unsupported_type');
  end if;
  if p_bytes is null or p_bytes < 1 then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  if p_bytes > (v_limits ->> 'max_bytes')::int then return jsonb_build_object('ok', false, 'reason', 'too_large'); end if;
  if (select count(*) from private.upload_tickets where user_id = p_user and created_at > now() - interval '1 day')
     >= (v_limits ->> 'per_user_per_day')::int then
    return jsonb_build_object('ok', false, 'reason', 'daily_limit');
  end if;
  v_path := p_feed || '/upload-' || v_id || '/file.' || v_ext;
  insert into private.upload_tickets (id, feed_id, user_id, filename, mime, declared_bytes, path)
  values (v_id, p_feed, p_user, v_name, p_mime, p_bytes, v_path);
  return jsonb_build_object('ok', true, 'ticket', v_id, 'path', v_path);
end;
$$;

-- The stored file was checked (size, real type) by the function; this records it once.
create function public.upload_finish(p_user uuid, p_ticket uuid, p_bytes integer, p_sha256 text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  t private.upload_tickets%rowtype;
  v_message uuid := gen_random_uuid();
begin
  select * into t from private.upload_tickets where id = p_ticket for update;
  if not found or t.user_id <> p_user then return jsonb_build_object('ok', false, 'reason', 'unknown_ticket'); end if;
  if t.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'already_used'); end if;
  if t.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if not exists (select 1 from public.feed_editors where feed_id = t.feed_id and user_id = p_user) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if p_bytes is null or p_bytes < 1 or p_bytes > (private.upload_limits() ->> 'max_bytes')::int then
    return jsonb_build_object('ok', false, 'reason', 'too_large');
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'reason', 'bad_hash'); end if;
  update private.upload_tickets set used_at = now() where id = t.id;
  insert into public.messages (id, feed_id, uploaded_by, status, received_at, reference_date, reference_date_source,
                               original_subject, subject, clean_text, attachment_count, raw_bytes, parsed_at)
  values (v_message, t.feed_id, p_user, 'parsed', now(), now(), 'received', t.filename, t.filename, '', 1, p_bytes, now());
  insert into public.attachments (message_id, filename, mime, bytes, sha256, storage_path, chosen, status)
  values (v_message, t.filename, t.mime, p_bytes, decode(p_sha256, 'hex'), t.path, true, 'pending');
  perform pgmq.send('triage_message', jsonb_build_object('message_id', v_message));
  return jsonb_build_object('ok', true, 'message', v_message, 'feed', t.feed_id);
end;
$$;

-- The function reads a ticket's storage spot before it checks the file.
create function public.upload_ticket(p_user uuid, p_ticket uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('path', t.path, 'mime', t.mime, 'feed', t.feed_id,
    'usable', t.used_at is null and t.expires_at >= now())
  from private.upload_tickets t where t.id = p_ticket and t.user_id = p_user
$$;

-- Hourly: a file uploaded but never finished goes to the storage trash an hour after its ticket
-- expired; tickets older than two days are dropped (a day is kept for the daily limit).
create function private.expire_upload_tickets()
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  t record;
  n integer := 0;
begin
  for t in select id, path from private.upload_tickets
           where used_at is null and expires_at < now() - interval '1 hour' loop
    perform private.trash('attachments', t.path);
    delete from private.upload_tickets where id = t.id;
    n := n + 1;
  end loop;
  delete from private.upload_tickets where created_at < now() - interval '2 days';
  return n;
end;
$$;
revoke all on function private.expire_upload_tickets() from public, anon, authenticated;
select cron.schedule('feedcal-expire-uploads', '23 * * * *', $$ select private.expire_upload_tickets() $$);

revoke all on function public.upload_start(uuid, uuid, text, text, integer), public.upload_finish(uuid, uuid, integer, text), public.upload_ticket(uuid, uuid) from public, anon, authenticated;
revoke all on function private.upload_limits() from public, anon, authenticated;

create or replace function private.reconcile_candidate(p_candidate_id uuid)
returns text
language plpgsql volatile set search_path = ''
as $$
declare
  c public.event_candidates%rowtype;
  m record;
  e public.events%rowtype;
  v_thread text;
  v_trusted boolean;
  v_threshold numeric;
  v_allowed boolean;
  v_outcome text;
  v_event uuid;
begin
  select * into c from public.event_candidates where id = p_candidate_id and state = 'pending' for update;
  if not found then return null; end if;
  -- D61: a file the calendar's own editor uploaded counts as a trusted sender.
  select private.thread_key(msg.original_subject),
         coalesce(s.trusted, false) or (msg.uploaded_by is not null and exists (
           select 1 from public.feed_editors fe where fe.feed_id = msg.feed_id and fe.user_id = msg.uploaded_by)),
         coalesce(f.auto_publish_threshold, 0.85)
    into v_thread, v_trusted, v_threshold
    from public.messages msg join public.feeds f on f.id = msg.feed_id left join public.sources s on s.id = msg.source_id
    where msg.id = c.message_id;
  -- D41: a trusted sender, nothing flagged, and either the feed's bar (85% unless changed) or a
  -- date the email's own words prove (checked in code, not by the model) at 50% or more.
  v_allowed := v_trusted and cardinality(c.review_reasons) = 0
    and (c.confidence >= v_threshold or (c.date_confirmed and c.confidence >= 0.5));
  select * into m from private.match_candidate(c, v_thread);
  if m.event_id is not null then select * into e from public.events where id = m.event_id; end if;

  if c.change_kind = 'cancelled' then
    if m.event_id is null then
      v_outcome := 'unmatched_change';
    elsif m.recurring_occurrence then
      v_outcome := 'exdate';
      if v_allowed and not (c.starts_at = any(e.exdates)) then
        update public.events set exdates = exdates || c.starts_at, updated_at = now() where id = e.id;
        perform private.revise(e.id, 'cancelled', jsonb_build_object('exdate', c.starts_at, 'evidence_quote', c.evidence_quote, 'candidate', c.id));
      end if;
    else
      v_outcome := 'cancel';
      if v_allowed and e.status <> 'cancelled' then
        update public.events set status = 'cancelled', updated_at = now() where id = e.id;
        perform private.revise(e.id, 'cancelled', jsonb_build_object('status', jsonb_build_array(e.status, 'cancelled'), 'evidence_quote', c.evidence_quote, 'candidate', c.id));
      end if;
    end if;
    v_event := m.event_id;

  elsif c.change_kind = 'changed' and m.event_id is not null and not m.same_start then
    v_outcome := 'update';
    v_event := m.event_id;
    if v_allowed then
      update public.events set starts_at = c.starts_at, ends_at = c.ends_at, all_day = c.all_day, timezone = c.timezone,
        location = coalesce(c.location, location), status = case when status = 'cancelled' then 'confirmed' else status end,
        evidence_quote = c.evidence_quote, source_message_id = c.message_id, updated_at = now()
        where id = e.id;
      perform private.revise(e.id, 'matched_update', jsonb_build_object(
        'starts_at', jsonb_build_array(e.starts_at, c.starts_at), 'ends_at', jsonb_build_array(e.ends_at, c.ends_at),
        'location', jsonb_build_array(e.location, coalesce(c.location, e.location)), 'evidence_quote', c.evidence_quote, 'candidate', c.id));
    end if;

  elsif m.event_id is not null and m.same_start and m.title_sim >= 0.35 then
    -- The same event again (another email, or the same one re-sent): nothing new to publish.
    v_outcome := 'duplicate';
    v_event := m.event_id;
    -- D59: only a trusted sender with nothing flagged may fill in a missing location. Before
    -- this, any sender's repeat of a published event could add a location families would see.
    if v_trusted and cardinality(c.review_reasons) = 0 and e.location is null and c.location is not null then
      update public.events set location = c.location, updated_at = now() where id = e.id;
    end if;
    v_allowed := true; -- a duplicate never needs review

  elsif m.event_id is not null and m.title_sim >= 0.6 and not m.recurring_occurrence
        and (m.event_id is not null) and (c.starts_at at time zone c.timezone)::date = (e.starts_at at time zone e.timezone)::date then
    -- Same event, same day, different time, but the email didn't say it changed: ask.
    v_outcome := 'conflict';
    v_event := m.event_id;
    v_allowed := false;

  elsif m.event_id is not null and m.recurring_occurrence and c.change_kind = 'new' then
    v_outcome := 'duplicate'; -- one occurrence of a series we already have
    v_event := m.event_id;
    v_allowed := true;

  else
    v_outcome := 'new';
    insert into public.events (feed_id, title, description, location, starts_at, ends_at, all_day, timezone, rrule, status,
      confidence, source_message_id, evidence_quote, published, source_thread)
    values (c.feed_id, c.title, c.description, c.location, c.starts_at, c.ends_at, c.all_day, c.timezone, c.rrule,
      case when v_allowed then 'confirmed' else 'tentative' end, c.confidence, c.message_id, c.evidence_quote, v_allowed, v_thread)
    returning id into v_event;
    perform private.revise(v_event, 'extracted', jsonb_build_object('candidate', c.id, 'published', v_allowed));
  end if;

  update public.event_candidates set
    outcome = v_outcome, match_score = m.score, event_id = v_event, decided_at = now(),
    state = case when v_allowed or v_outcome = 'new' then 'applied' else 'needs_review' end
  where id = c.id;
  return v_outcome;
end;
$$;
