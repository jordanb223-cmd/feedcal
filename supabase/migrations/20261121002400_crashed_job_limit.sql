-- D60: a job whose worker keeps getting killed (CPU limit, crash) never reached its failure
-- handler, so it came back every few minutes forever, blocking the jobs read with it. Now, each
-- time jobs are claimed, any job already read 5 times that has become visible again is handed to
-- its queue's own failure handler first. The claim functions below are unchanged apart from that.

create or replace function private.give_up_crashed_jobs(p_queue text)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  j record;
  n integer := 0;
begin
  if p_queue not in ('process_message', 'triage_message', 'extract_message') then
    raise exception 'unknown queue %', p_queue;
  end if;
  for j in execute format(
    'select msg_id, (message ->> %L)::uuid as message_id from pgmq.%I where read_ct >= 5 and vt <= clock_timestamp() limit 20',
    'message_id', 'q_' || p_queue)
  loop
    if p_queue = 'process_message' then perform public.fail_process_job(j.msg_id, j.message_id, 0);
    elsif p_queue = 'triage_message' then perform public.fail_triage_job(j.msg_id, j.message_id);
    elsif p_queue = 'extract_message' then perform public.fail_extract_job(j.msg_id, j.message_id);
    else raise exception 'unknown queue %', p_queue;
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function private.give_up_crashed_jobs(text) from public, anon, authenticated;

create or replace function public.claim_process_jobs(p_limit integer default 5, p_visibility_seconds integer default 120)
returns table (job_id bigint, message_id uuid, feed_id uuid, storage_path text, attempts integer, received_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.give_up_crashed_jobs('process_message');
  return query
  select q.msg_id, m.id, m.feed_id, m.storage_path, q.read_ct, m.received_at
  from pgmq.read('process_message', least(greatest(p_visibility_seconds, 10), 900), least(greatest(p_limit, 1), 20)) q
  left join public.messages m on m.id = (q.message ->> 'message_id')::uuid;
end;
$$;

create or replace function public.claim_triage_jobs(p_limit integer default 3, p_visibility_seconds integer default 300)
returns table (job_id bigint, message_id uuid, feed_id uuid, attachment_rule jsonb, attachments jsonb)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.give_up_crashed_jobs('triage_message');
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

create or replace function public.claim_extract_jobs(p_limit integer default 3, p_visibility_seconds integer default 300)
returns table (job_id bigint, message_id uuid, feed_id uuid, context jsonb)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.give_up_crashed_jobs('extract_message');
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
