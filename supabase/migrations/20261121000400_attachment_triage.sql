-- Phase 8: attachment triage, cheapest step first (D29).
-- After parsing, each message goes on the "triage_message" queue. The triage-attachments Edge
-- Function reads its attachments in stages (owner's rule -> metadata -> PDF text layer -> vision
-- last), keeps at most 5 pages per message for the AI, and stores them in attachment_pages.
-- Then the message goes on "extract_message" (Phase 9).

select pgmq.create('triage_message');
select pgmq.create('extract_message');

alter table public.attachments
  add column triage jsonb,         -- stage reached, reason, page scores, cost estimate
  add column triaged_at timestamptz;
alter table public.messages
  add column triaged_at timestamptz,
  add column pages_for_ai smallint check (pages_for_ai is null or pages_for_ai between 0 and 5);

-- New legal moves: the owner can rule out a file that was already read, or have it re-read.
insert into private.state_transitions (machine, from_state, to_state, description) values
  ('attachment_status', 'text_layer', 'skipped', 'The owner said "never use files like this"'),
  ('attachment_status', 'transcribed', 'skipped', 'The owner said "never use files like this"'),
  ('attachment_status', 'text_layer', 'pending', 'Re-read after the owner picked a file'),
  ('attachment_status', 'transcribed', 'pending', 'Re-read after the owner picked a file');

-- ---------------------------------------------------------------- daily caps per owner
create table private.usage_daily (
  user_id uuid not null,
  day date not null default current_date,
  kind text not null check (kind in ('text_pages', 'vision_pages')),
  amount integer not null default 0 check (amount >= 0),
  primary key (user_id, day, kind)
);
alter table private.usage_daily enable row level security;
revoke all on table private.usage_daily from public, anon, authenticated;

create function private.triage_limits()
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'pages_per_message', 5,
    'max_bytes', 15 * 1024 * 1024,
    'max_pages', 40,
    'text_pages_per_day', 300,
    'vision_pages_per_day', 20)
$$;
revoke all on function private.triage_limits() from public;

-- Grants up to p_wanted units for the feed owner's day and records them. Returns the grant (0 = over).
create function public.take_quota(p_feed_id uuid, p_kind text, p_wanted integer)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_owner uuid;
  v_limit integer := (private.triage_limits() ->> (p_kind || '_per_day'))::int;
  v_used integer;
  v_grant integer;
begin
  select owner_id into v_owner from public.feeds where id = p_feed_id;
  if v_owner is null or v_limit is null or p_wanted <= 0 then
    return 0;
  end if;
  insert into private.usage_daily (user_id, kind) values (v_owner, p_kind) on conflict do nothing;
  select amount into v_used from private.usage_daily where user_id = v_owner and day = current_date and kind = p_kind for update;
  v_grant := greatest(0, least(p_wanted, v_limit - v_used));
  update private.usage_daily set amount = amount + v_grant where user_id = v_owner and day = current_date and kind = p_kind;
  return v_grant;
end;
$$;

-- ---------------------------------------------------------------- parse -> triage hand-off
-- Same as Phase 7, plus: a parsed message goes on to triage.
create or replace function public.record_parsed_message(p_message_id uuid, p_parsed jsonb, p_attachments jsonb)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_status text;
  v_quarantine text;
  v_new text;
  a jsonb;
begin
  select status, quarantine_reason into v_status, v_quarantine from public.messages
    where id = p_message_id for update;
  if v_quarantine is not null then
    return 'quarantined';
  end if;
  if v_status is distinct from 'received' then
    return coalesce(v_status, 'missing');
  end if;

  for a in select * from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    insert into public.attachments (message_id, filename, mime, bytes, sha256, storage_path, inline, content_id, width, height)
    values (p_message_id, a ->> 'filename', a ->> 'mime', (a ->> 'bytes')::bigint, decode(a ->> 'sha256', 'hex'),
            a ->> 'storage_path', coalesce((a ->> 'inline')::boolean, false), a ->> 'contentId',
            nullif((a ->> 'width')::int, 0), nullif((a ->> 'height')::int, 0))
    on conflict (message_id, sha256) where sha256 is not null do nothing;
  end loop;

  v_new := case
    when coalesce(length(trim(p_parsed ->> 'cleanText')), 0) = 0 and jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) = 0
      then 'ignored' else 'parsed' end;
  update public.messages set
    status = v_new,
    reference_date = (p_parsed ->> 'referenceDate')::timestamptz,
    reference_date_source = p_parsed ->> 'referenceDateSource',
    original_sender = left(p_parsed -> 'sender' ->> 'address', 320),
    original_subject = left(p_parsed ->> 'subject', 998),
    clean_text = left(p_parsed ->> 'cleanText', 100000),
    stripped_text = left(p_parsed ->> 'strippedText', 100000),
    language = p_parsed ->> 'language',
    parse_details = jsonb_build_object(
      'forwardNotes', p_parsed -> 'forwardNotes', 'forwardDepth', p_parsed -> 'forwardDepth',
      'bodySource', p_parsed -> 'bodySource', 'discarded', p_parsed -> 'discarded', 'senderName', p_parsed -> 'sender' -> 'name'),
    parsed_at = now()
  where id = p_message_id;
  if v_new = 'parsed' then
    perform pgmq.send('triage_message', jsonb_build_object('message_id', p_message_id));
  end if;
  return v_new;
end;
$$;

-- ---------------------------------------------------------------- triage jobs (service role)
-- One row per claimed job, with everything triage needs: the sender's learned rule, and each
-- attachment with whether the same file was already read for this feed ("seen before").
create function public.claim_triage_jobs(p_limit integer default 3, p_visibility_seconds integer default 300)
returns table (job_id bigint, message_id uuid, feed_id uuid, attachment_rule jsonb, attachments jsonb)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  return query
  select q.msg_id, m.id, m.feed_id, s.attachment_rule,
    coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'filename', a.filename, 'mime', a.mime, 'bytes', a.bytes, 'storage_path', a.storage_path,
        'status', a.status, 'chosen', a.chosen, 'width', a.width, 'height', a.height, 'inline', a.inline,
        'owner_never', coalesce(a.triage ->> 'reason', '') = 'owner_never',
        'seen_before', exists (
          select 1 from public.attachments o join public.messages om on om.id = o.message_id
          where om.feed_id = m.feed_id and o.sha256 = a.sha256 and o.message_id <> a.message_id
            and o.status in ('text_layer', 'transcribed'))
      ) order by a.created_at, a.id) from public.attachments a where a.message_id = m.id), '[]'::jsonb)
  from pgmq.read('triage_message', least(greatest(p_visibility_seconds, 30), 900), least(greatest(p_limit, 1), 10)) q
  left join public.messages m on m.id = (q.message ->> 'message_id')::uuid
  left join public.sources s on s.id = m.source_id;
end;
$$;

create function public.finish_triage_job(p_job_id bigint)
returns boolean
language sql volatile security definer set search_path = ''
as $$ select pgmq.delete('triage_message', p_job_id) $$;

-- Gives up after 5 tries: the attachments stay as they are and the message moves on without them.
create function public.fail_triage_job(p_job_id bigint, p_message_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_reads integer;
begin
  select read_ct into v_reads from pgmq.q_triage_message where msg_id = p_job_id;
  if v_reads is null or v_reads >= 5 then
    perform pgmq.archive('triage_message', p_job_id);
    update public.messages set triaged_at = now(), pages_for_ai = 0 where id = p_message_id and triaged_at is null;
    perform pgmq.send('extract_message', jsonb_build_object('message_id', p_message_id));
    return 'gave_up';
  end if;
  return 'retry';
end;
$$;

-- Records one triage. Safe to repeat: each attachment's pages are replaced, not added.
-- p_results: [{id, status, pages: [{index, text, source}], pages_total, triage: {...}}]
create function public.record_triage(p_message_id uuid, p_results jsonb)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  r jsonb;
  p jsonb;
  v_pages integer := 0;
  v_status text;
begin
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    select status into v_status from public.attachments where id = (r ->> 'id')::uuid and message_id = p_message_id for update;
    if v_status is null then
      continue;
    end if;
    if v_status is distinct from (r ->> 'status') then
      -- Re-reading can need a move that isn't direct (failed -> text_layer); go through pending.
      if v_status <> 'pending' and not exists (select 1 from private.state_transitions t
           where t.machine = 'attachment_status' and t.from_state = v_status and t.to_state = r ->> 'status') then
        update public.attachments set status = 'pending' where id = (r ->> 'id')::uuid;
      end if;
      if (r ->> 'status') <> 'pending' then
        update public.attachments set status = r ->> 'status' where id = (r ->> 'id')::uuid;
      end if;
    end if;
    update public.attachments set
      pages = coalesce(nullif(r ->> 'pages_total', '')::int, pages),
      triage = r -> 'triage',
      triaged_at = now()
    where id = (r ->> 'id')::uuid;
    delete from public.attachment_pages where attachment_id = (r ->> 'id')::uuid;
    for p in select * from jsonb_array_elements(coalesce(r -> 'pages', '[]'::jsonb)) loop
      insert into public.attachment_pages (attachment_id, page_index, text, text_source)
      values ((r ->> 'id')::uuid, (p ->> 'index')::int, left(p ->> 'text', 50000),
              case when p ->> 'source' = 'transcription' then 'transcription' else 'text_layer' end);
      v_pages := v_pages + 1;
    end loop;
  end loop;
  update public.messages set triaged_at = now(), pages_for_ai = least(v_pages, 5) where id = p_message_id;
  perform pgmq.send('extract_message', jsonb_build_object('message_id', p_message_id));
  return v_pages;
end;
$$;

revoke all on function public.take_quota(uuid, text, integer), public.claim_triage_jobs(integer, integer),
  public.finish_triage_job(bigint), public.fail_triage_job(bigint, uuid), public.record_triage(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.take_quota(uuid, text, integer), public.claim_triage_jobs(integer, integer),
  public.finish_triage_job(bigint), public.fail_triage_job(bigint, uuid), public.record_triage(uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------- owner feedback (members)
-- A filename pattern that matches next week's file too: lower-cased, regex-escaped, digit runs
-- generalised. "Schedule-Week-47.pdf" -> ^schedule-week-\d+\.pdf$
create function private.filename_pattern(p_filename text)
returns text
language sql immutable set search_path = ''
as $$
  select '^' || regexp_replace(
                  regexp_replace(lower(coalesce(p_filename, '')), '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'),
                  '[0-9]+', '\\d+', 'g') || '$'
$$;
revoke all on function private.filename_pattern(text) from public;

create function private.attachment_context(p_attachment_id uuid)
returns table (message_id uuid, feed_id uuid, source_id uuid, filename text, mime text, kept_pages jsonb)
language sql stable set search_path = ''
as $$
  select a.message_id, m.feed_id, m.source_id, a.filename, a.mime, a.triage -> 'keptPages'
  from public.attachments a join public.messages m on m.id = a.message_id where a.id = p_attachment_id
$$;
revoke all on function private.attachment_context(uuid) from public;

-- "This one has the schedule": learn it for the sender, and re-read this email with it.
create function public.choose_attachment(p_attachment_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c record;
  v_rule jsonb;
  v_prefer jsonb;
begin
  select * into c from private.attachment_context(p_attachment_id);
  if c.feed_id is null or not private.is_feed_member(c.feed_id) then
    raise exception 'Attachment not found.' using errcode = 'P0002';
  end if;
  update public.attachments set chosen = (id = p_attachment_id) where message_id = c.message_id;
  if c.source_id is not null then
    select coalesce(attachment_rule, '{}'::jsonb) into v_rule from public.sources where id = c.source_id;
    v_prefer := jsonb_build_object('pattern', private.filename_pattern(c.filename), 'mime', c.mime,
                                   'pages', coalesce(c.kept_pages, '[]'::jsonb));
    v_rule := jsonb_set(v_rule, '{version}', '1') || jsonb_build_object('prefer',
      jsonb_build_array(v_prefer) || coalesce((select jsonb_agg(x) from jsonb_array_elements(v_rule -> 'prefer') x
                                               where x ->> 'pattern' <> v_prefer ->> 'pattern'), '[]'::jsonb));
    v_rule := jsonb_set(v_rule, '{prefer}', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(v_rule -> 'prefer') x limit 5) t));
    -- A file the owner picks is no longer "never".
    v_rule := jsonb_set(v_rule, '{never}', coalesce((select jsonb_agg(x) from jsonb_array_elements(v_rule -> 'never') x
                                                     where x ->> 'pattern' <> v_prefer ->> 'pattern'), '[]'::jsonb));
    update public.sources set attachment_rule = v_rule where id = c.source_id;
  end if;
  update public.attachments set status = 'pending'
    where message_id = c.message_id and status in ('skipped', 'text_layer', 'transcribed', 'failed');
  perform pgmq.send('triage_message', jsonb_build_object('message_id', c.message_id));
  return v_rule;
end;
$$;

-- "Never use files like this": learn it for the sender; this file stops being used now.
create function public.never_use_attachment(p_attachment_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c record;
  v_rule jsonb;
  v_never jsonb;
begin
  select * into c from private.attachment_context(p_attachment_id);
  if c.feed_id is null or not private.is_feed_member(c.feed_id) then
    raise exception 'Attachment not found.' using errcode = 'P0002';
  end if;
  v_never := jsonb_build_object('pattern', private.filename_pattern(c.filename), 'mime', c.mime);
  if c.source_id is not null then
    select coalesce(attachment_rule, '{}'::jsonb) into v_rule from public.sources where id = c.source_id;
    v_rule := jsonb_set(v_rule, '{version}', '1')
      || jsonb_build_object('never', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
           select v_never as x union select x from jsonb_array_elements(coalesce(v_rule -> 'never', '[]')) x limit 20) t))
      || jsonb_build_object('prefer', coalesce((select jsonb_agg(x) from jsonb_array_elements(v_rule -> 'prefer') x
                                                where x ->> 'pattern' <> v_never ->> 'pattern'), '[]'::jsonb));
    update public.sources set attachment_rule = v_rule where id = c.source_id;
  end if;
  update public.attachments set chosen = false, status = 'skipped',
    triage = coalesce(triage, '{}'::jsonb) || '{"stage": 0, "reason": "owner_never"}'
    where id = p_attachment_id and status in ('pending', 'text_layer', 'transcribed');
  delete from public.attachment_pages where attachment_id = p_attachment_id;
  perform pgmq.send('triage_message', jsonb_build_object('message_id', c.message_id));
  return v_rule;
end;
$$;

-- "Schedules from this sender come as big attachments": lift the 15 MB / 40-page skip.
create function public.set_sender_large_attachments(p_source_id uuid, p_allow boolean)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed uuid;
begin
  select feed_id into v_feed from public.sources where id = p_source_id;
  if v_feed is null or not private.is_feed_member(v_feed) then
    raise exception 'Sender not found.' using errcode = 'P0002';
  end if;
  update public.sources set attachment_rule = coalesce(attachment_rule, '{}'::jsonb) || jsonb_build_object('version', 1, 'allowLarge', p_allow)
    where id = p_source_id;
  return p_allow;
end;
$$;

revoke all on function public.choose_attachment(uuid), public.never_use_attachment(uuid), public.set_sender_large_attachments(uuid, boolean) from public, anon;
grant execute on function public.choose_attachment(uuid), public.never_use_attachment(uuid), public.set_sender_large_attachments(uuid, boolean) to authenticated;

-- Members can read their feeds' attachment files (thumbnails on the email page, through signed URLs).
-- Paths are <feed_id>/<message_id>/<sha256>.
create policy attachments_member_read on storage.objects
  for select to authenticated
  using (bucket_id = 'attachments'
         and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
         and private.is_feed_member(((storage.foldername(name))[1])::uuid));

select cron.schedule('feedcal-triage-attachments', '* * * * *', $$ select private.call_edge_function('triage-attachments') $$);
