-- D41: deterministic date rules (2026-11-21, owner's request: auto-publish for everyone, with
-- checks strict enough not to put wrong dates on calendars). The extraction code checks each
-- event's date and time against the quoted words and the email's sent date. A proven date lets a
-- trusted sender's event publish at 50% confidence; contradictions and ambiguities are review
-- reasons, which always wait for the owner. Feeds keep their own bar (85% unless changed) for
-- dates the words don't prove.

alter table public.event_candidates add column date_confirmed boolean not null default false;

create or replace function public.record_extraction(p_message_id uuid, p_result jsonb)
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
      rrule, change_kind, confidence, evidence_quote, source_kind, attachment_id, page_index, from_transcription, review_reasons, model, date_confirmed)
    values (p_message_id, v_feed, left(c ->> 'title', 300), (c ->> 'starts_at')::timestamptz, (c ->> 'ends_at')::timestamptz,
      (c ->> 'all_day')::boolean, c ->> 'timezone', left(c ->> 'location', 500), left(c ->> 'description', 2000),
      left(c ->> 'recurrence', 300), c ->> 'status', least(greatest((c ->> 'confidence')::numeric, 0), 1), left(c ->> 'evidence_quote', 1000),
      c -> 'source_ref' ->> 'kind',
      (select a.id from public.attachments a where a.id::text = c -> 'source_ref' ->> 'attachment_id' and a.message_id = p_message_id),
      (c -> 'source_ref' ->> 'page_index')::int, coalesce((c ->> 'from_transcription')::boolean, false),
      coalesce((select array_agg(x) from jsonb_array_elements_text(c -> 'review') x), '{}'), p_result ->> 'model',
      coalesce((c ->> 'date_confirmed')::boolean, false));
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
  select private.thread_key(msg.original_subject), coalesce(s.trusted, false), coalesce(f.auto_publish_threshold, 0.85)
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
    if e.location is null and c.location is not null then
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
