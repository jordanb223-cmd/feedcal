-- Phase 7: parse queued emails (D28). The process-messages Edge Function claims jobs from the
-- pgmq queue "process_message", parses each raw email (postal-mime, forwards unwrapped, quotes
-- and signatures stripped, logos dropped), stores real attachments in the private "attachments"
-- bucket, and records the result here. Status: received -> parsed (or ignored / failed).

alter table public.messages
  add column reference_date timestamptz,
  add column reference_date_source text check (reference_date_source is null or reference_date_source in ('forwarded_header', 'date_header', 'received')),
  add column original_sender text check (original_sender is null or char_length(original_sender) <= 320),
  add column original_subject text check (original_subject is null or char_length(original_subject) <= 998),
  -- What later phases send to the AI.
  add column clean_text text check (clean_text is null or char_length(clean_text) <= 100000),
  -- Quoted replies and signatures: kept as evidence, never sent to the AI.
  add column stripped_text text check (stripped_text is null or char_length(stripped_text) <= 100000),
  add column language text check (language is null or language ~ '^([a-z]{2}|und)$'),
  -- forwardNotes, forwardDepth, bodySource, discarded attachments.
  add column parse_details jsonb,
  add column parsed_at timestamptz,
  add column parse_attempts smallint not null default 0;

alter table public.attachments
  add column inline boolean not null default false,
  add column content_id text check (content_id is null or char_length(content_id) <= 255),
  add column width integer check (width is null or width > 0),
  add column height integer check (height is null or height > 0);
-- Recording the same message twice never duplicates its files.
create unique index attachments_message_sha_idx on public.attachments (message_id, sha256) where sha256 is not null;

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 20 * 1024 * 1024)
on conflict (id) do nothing;

-- Deleting an attachment row (including by cascade when its message expires) queues its file.
create function private.attachments_trash_file()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.storage_path is not null then
    perform private.trash('attachments', old.storage_path);
  end if;
  return old;
end;
$$;
revoke all on function private.attachments_trash_file() from public;
create trigger attachments_trash_file after delete on public.attachments
  for each row execute function private.attachments_trash_file();

-- ---------------------------------------------------------------- queue access (service role)
-- pgmq lives in its own schema, which the API doesn't expose; these wrap it.
-- Claimed jobs are invisible to other workers for p_visibility_seconds, then reappear if not
-- finished, so a crash mid-parse is retried.
create function public.claim_process_jobs(p_limit integer default 5, p_visibility_seconds integer default 120)
returns table (job_id bigint, message_id uuid, feed_id uuid, storage_path text, attempts integer, received_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  return query
  select q.msg_id, m.id, m.feed_id, m.storage_path, q.read_ct, m.received_at
  from pgmq.read('process_message', least(greatest(p_visibility_seconds, 10), 900), least(greatest(p_limit, 1), 20)) q
  left join public.messages m on m.id = (q.message ->> 'message_id')::uuid;
end;
$$;

create function public.finish_process_job(p_job_id bigint)
returns boolean
language sql volatile security definer set search_path = ''
as $$ select pgmq.delete('process_message', p_job_id) $$;

-- Records one parse. Only a message still waiting ('received', not quarantined) changes, so a
-- repeat or a late duplicate job is harmless. No text and no attachments -> 'ignored'.
create function public.record_parsed_message(p_message_id uuid, p_parsed jsonb, p_attachments jsonb)
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
  return v_new;
end;
$$;

-- A parse that keeps failing: after 5 tries the message is marked failed and the job dropped.
create function public.fail_process_job(p_job_id bigint, p_message_id uuid, p_max_attempts integer default 5)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_attempts integer;
begin
  update public.messages set parse_attempts = parse_attempts + 1
    where id = p_message_id returning parse_attempts into v_attempts;
  if v_attempts is null then
    perform pgmq.delete('process_message', p_job_id);
    return 'missing';
  end if;
  if v_attempts >= p_max_attempts then
    update public.messages set status = 'failed' where id = p_message_id and status = 'received';
    perform pgmq.archive('process_message', p_job_id);
    return 'failed';
  end if;
  return 'retry';
end;
$$;

revoke all on function public.claim_process_jobs(integer, integer), public.finish_process_job(bigint),
  public.record_parsed_message(uuid, jsonb, jsonb), public.fail_process_job(bigint, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_process_jobs(integer, integer), public.finish_process_job(bigint),
  public.record_parsed_message(uuid, jsonb, jsonb), public.fail_process_job(bigint, uuid, integer)
  to service_role;

-- Every minute. The function does nothing when the queue is empty.
select cron.schedule('feedcal-process-messages', '* * * * *', $$ select private.call_edge_function('process-messages') $$);
