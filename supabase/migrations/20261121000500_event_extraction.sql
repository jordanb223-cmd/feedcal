-- Phase 9: AI event extraction (D30). The extract-events Edge Function reads each triaged message
-- (clean text + kept pages), asks the model for events, checks every evidence quote and date, and
-- records CANDIDATES here. Phase 10's reconciler turns candidates into feed events.

select pgmq.create('reconcile_message');

alter table public.feeds add column timezone text not null default 'America/Los_Angeles'
  check (timezone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){0,2}$');
grant select (timezone) on table public.feeds to authenticated;
grant update (timezone) on table public.feeds to authenticated;

alter table public.messages add column extraction jsonb; -- {state, reason, model, calls, rejected}

-- Daily AI calls per owner, alongside the triage caps.
alter table private.usage_daily drop constraint usage_daily_kind_check;
alter table private.usage_daily add constraint usage_daily_kind_check check (kind in ('text_pages', 'vision_pages', 'ai_calls'));
create or replace function private.triage_limits()
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'pages_per_message', 5,
    'max_bytes', 15 * 1024 * 1024,
    'max_pages', 40,
    'text_pages_per_day', 300,
    'vision_pages_per_day', 20,
    'ai_calls_per_day', 60)
$$;

create table public.event_candidates (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  feed_id uuid not null references public.feeds (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null,
  timezone text not null,
  location text check (location is null or char_length(location) <= 500),
  description text check (description is null or char_length(description) <= 2000),
  rrule text check (rrule is null or char_length(rrule) <= 300),
  change_kind text not null check (change_kind in ('new', 'changed', 'cancelled')),
  confidence numeric(4, 3) not null check (confidence between 0 and 1),
  evidence_quote text not null check (char_length(evidence_quote) between 3 and 1000),
  source_kind text not null check (source_kind in ('body', 'page')),
  attachment_id uuid references public.attachments (id) on delete set null,
  page_index integer check (page_index is null or page_index >= 0),
  from_transcription boolean not null default false,
  review_reasons text[] not null default '{}',
  -- pending -> (Phase 10) matched into an event, or rejected / needs review by the owner.
  state text not null default 'pending' check (state in ('pending', 'applied', 'needs_review', 'rejected')),
  event_id uuid references public.events (id) on delete set null,
  model text,
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);
create index event_candidates_message_idx on public.event_candidates (message_id);
create index event_candidates_feed_state_idx on public.event_candidates (feed_id, state);
alter table public.event_candidates enable row level security;
revoke all on table public.event_candidates from anon, authenticated;
grant select on table public.event_candidates to authenticated;
create policy event_candidates_member_select on public.event_candidates
  for select to authenticated using (private.is_feed_member(feed_id));

-- ---------------------------------------------------------------- jobs (service role)
create function public.claim_extract_jobs(p_limit integer default 3, p_visibility_seconds integer default 300)
returns table (job_id bigint, message_id uuid, feed_id uuid, context jsonb)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  return query
  select q.msg_id, m.id, m.feed_id,
    case when m.id is null then null else jsonb_build_object(
      'referenceDate', coalesce(m.reference_date, m.received_at),
      'timezone', f.timezone, 'feedName', f.name, 'feedCategory', f.category,
      'subject', m.original_subject, 'sender', m.original_sender,
      'body', coalesce(m.clean_text, ''),
      'pages', coalesce((select jsonb_agg(jsonb_build_object(
          'attachment_id', a.id, 'page_index', p.page_index, 'text', coalesce(p.text, ''),
          'source', p.text_source, 'filename', a.filename) order by a.created_at, p.page_index)
        from public.attachments a join public.attachment_pages p on p.attachment_id = a.id
        where a.message_id = m.id and a.status in ('text_layer', 'transcribed')), '[]'::jsonb)
    ) end
  from pgmq.read('extract_message', least(greatest(p_visibility_seconds, 30), 900), least(greatest(p_limit, 1), 10)) q
  left join public.messages m on m.id = (q.message ->> 'message_id')::uuid
  left join public.feeds f on f.id = m.feed_id;
end;
$$;

create function public.finish_extract_job(p_job_id bigint)
returns boolean
language sql volatile security definer set search_path = ''
as $$ select pgmq.delete('extract_message', p_job_id) $$;

create function public.fail_extract_job(p_job_id bigint, p_message_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_reads integer;
begin
  select read_ct into v_reads from pgmq.q_extract_message where msg_id = p_job_id;
  if v_reads is null or v_reads >= 5 then
    perform pgmq.archive('extract_message', p_job_id);
    update public.messages set status = 'failed', extraction = jsonb_build_object('state', 'failed', 'reason', 'gave_up')
      where id = p_message_id and status = 'parsed';
    return 'gave_up';
  end if;
  return 'retry';
end;
$$;

-- No API key or over today's cap: the message waits, and can be re-queued later.
create function public.record_extraction_waiting(p_message_id uuid, p_reason text)
returns void
language sql volatile security definer set search_path = ''
as $$
  update public.messages set extraction = jsonb_build_object('state', 'waiting', 'reason', left(p_reason, 60), 'at', now())
  where id = p_message_id
$$;

create function public.requeue_waiting_extractions(p_limit integer default 100)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in select id from public.messages where extraction ->> 'state' = 'waiting' and status = 'parsed'
              order by received_at limit least(greatest(p_limit, 1), 1000) loop
    perform pgmq.send('extract_message', jsonb_build_object('message_id', v_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Records one extraction. Safe to repeat: the message's still-pending candidates are replaced.
-- p_result: {state, reason, model, calls, rejected: [...], candidates: [...]} (pipeline.ts)
create function public.record_extraction(p_message_id uuid, p_result jsonb)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed uuid;
  v_status text;
  c jsonb;
  v_count integer := 0;
  v_new_status text;
begin
  select feed_id, status into v_feed, v_status from public.messages where id = p_message_id for update;
  if v_feed is null then
    return 0;
  end if;
  delete from public.event_candidates where message_id = p_message_id and state = 'pending';
  for c in select * from jsonb_array_elements(coalesce(p_result -> 'candidates', '[]'::jsonb)) loop
    insert into public.event_candidates (message_id, feed_id, title, starts_at, ends_at, all_day, timezone, location, description,
      rrule, change_kind, confidence, evidence_quote, source_kind, attachment_id, page_index, from_transcription, review_reasons, model)
    values (p_message_id, v_feed, left(c ->> 'title', 300), (c ->> 'starts_at')::timestamptz, (c ->> 'ends_at')::timestamptz,
      (c ->> 'all_day')::boolean, c ->> 'timezone', left(c ->> 'location', 500), left(c ->> 'description', 2000),
      left(c ->> 'recurrence', 300), c ->> 'status', least(greatest((c ->> 'confidence')::numeric, 0), 1), left(c ->> 'evidence_quote', 1000),
      c -> 'source_ref' ->> 'kind',
      (select a.id from public.attachments a where a.id::text = c -> 'source_ref' ->> 'attachment_id' and a.message_id = p_message_id),
      (c -> 'source_ref' ->> 'page_index')::int, coalesce((c ->> 'from_transcription')::boolean, false),
      coalesce((select array_agg(x) from jsonb_array_elements_text(c -> 'review') x), '{}'), p_result ->> 'model');
    v_count := v_count + 1;
  end loop;

  v_new_status := case p_result ->> 'state' when 'extracted' then 'extracted' when 'refused' then 'needs_review' else 'needs_review' end;
  if v_status = 'parsed' then
    update public.messages set status = v_new_status where id = p_message_id;
  elsif v_status = 'extracted' and v_new_status = 'needs_review' then
    update public.messages set status = 'needs_review' where id = p_message_id;
  end if;
  update public.messages set extraction = jsonb_build_object(
      'state', p_result ->> 'state', 'reason', p_result ->> 'reason', 'model', p_result ->> 'model',
      'calls', p_result -> 'calls', 'rejected', p_result -> 'rejected', 'candidates', v_count, 'at', now())
    where id = p_message_id;
  perform pgmq.send('reconcile_message', jsonb_build_object('message_id', p_message_id));
  return v_count;
end;
$$;

revoke all on function public.claim_extract_jobs(integer, integer), public.finish_extract_job(bigint), public.fail_extract_job(bigint, uuid),
  public.record_extraction_waiting(uuid, text), public.requeue_waiting_extractions(integer), public.record_extraction(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_extract_jobs(integer, integer), public.finish_extract_job(bigint), public.fail_extract_job(bigint, uuid),
  public.record_extraction_waiting(uuid, text), public.requeue_waiting_extractions(integer), public.record_extraction(uuid, jsonb)
  to service_role;

select cron.schedule('feedcal-extract-events', '* * * * *', $$ select private.call_edge_function('extract-events') $$);
