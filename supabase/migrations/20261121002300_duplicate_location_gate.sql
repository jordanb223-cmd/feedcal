-- D59: a repeated event no longer lets an untrusted (or flagged) email fill in a published
-- event's missing location. Same function as 20261121001800_date_gates.sql, one guarded block.
-- `create or replace` keeps the existing grants (none to anon/authenticated; see the reconciler).

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

