-- Phase 10: matching extracted candidates to the feed's events (D31). Pure SQL, run every minute
-- by pg_cron from the "reconcile_message" queue. Outcomes per candidate:
--   new | update (SEQUENCE bumps, revision written) | cancel (kept 30 days) | exdate (one
--   occurrence of a series) | duplicate | conflict (review). Never deletes an event.
-- Applies automatically only when confidence >= the feed's threshold AND the sender is trusted
-- AND the candidate has no review reasons; otherwise the candidate waits for the owner (Phase 11).

create extension if not exists pg_trgm with schema extensions;

alter table public.events
  add column exdates timestamptz[] not null default '{}',
  add column source_thread text check (source_thread is null or char_length(source_thread) <= 300);
create index events_title_trgm_idx on public.events using gin (lower(title) extensions.gin_trgm_ops);

alter table public.event_candidates
  add column outcome text check (outcome is null or outcome in ('new', 'update', 'cancel', 'exdate', 'duplicate', 'conflict', 'unmatched_change')),
  add column match_score numeric(4, 3),
  add column decided_at timestamptz;

-- Skipping one occurrence is a change subscribers must see, so SEQUENCE covers exdates too.
create or replace function private.events_bump_sequence()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (new.title, new.description, new.location, new.starts_at, new.ends_at, new.all_day,
      new.timezone, new.rrule, new.status, new.exdates)
     is distinct from
     (old.title, old.description, old.location, old.starts_at, old.ends_at, old.all_day,
      old.timezone, old.rrule, old.status, old.exdates)
     and new.sequence <= old.sequence then
    new.sequence := old.sequence + 1;
  end if;
  return new;
end;
$$;

-- "Re: Fwd: Practice schedule" and "Practice schedule" are one thread.
create function private.thread_key(p_subject text)
returns text
language sql immutable set search_path = ''
as $$
  select nullif(left(lower(trim(regexp_replace(coalesce(p_subject, ''), '^\s*((re|fw|fwd|aw|wg)\s*:\s*)+', '', 'i'))), 300), '')
$$;

-- Does a recurring event have an occurrence starting at p_at (same local time, a BYDAY day,
-- on or after the first, before UNTIL)? Enough for weekly practices; other rules don't match.
create function private.occurs_at(p_event public.events, p_at timestamptz)
returns boolean
language plpgsql stable set search_path = ''
as $$
declare
  v_local timestamp := p_at at time zone p_event.timezone;
  v_first timestamp := p_event.starts_at at time zone p_event.timezone;
  v_byday text := substring(p_event.rrule from 'BYDAY=([A-Z,]+)');
  v_until text := substring(p_event.rrule from 'UNTIL=([0-9]{8})');
  v_day text := (array['SU','MO','TU','WE','TH','FR','SA'])[extract(dow from v_local)::int + 1];
begin
  if p_event.rrule is null or p_event.rrule !~ '^FREQ=WEEKLY' then return false; end if;
  if v_local < v_first then return false; end if;
  if not p_event.all_day and v_local::time <> v_first::time then return false; end if;
  if v_until is not null and v_local::date > to_date(v_until, 'YYYYMMDD') then return false; end if;
  if v_byday is not null then return v_day = any(string_to_array(v_byday, ',')); end if;
  return extract(dow from v_local) = extract(dow from v_first);
end;
$$;

-- The best existing event for a candidate, or nothing. Title similarity (trigrams) carries most
-- of the weight; the same thread, a matching location and a nearby date add to it.
create function private.match_candidate(p_c public.event_candidates, p_thread text)
returns table (event_id uuid, score numeric, title_sim numeric, same_start boolean, recurring_occurrence boolean)
language sql stable set search_path = ''
as $$
  select e.id,
    round((0.6 * t.sim
      + case when p_thread is not null and e.source_thread = p_thread then 0.2 else 0 end
      + case when e.location is not null and p_c.location is not null
             and extensions.similarity(lower(e.location), lower(p_c.location)) > 0.4 then 0.1 else 0 end
      + 0.1 * greatest(0, 1 - abs(extract(epoch from (e.starts_at - p_c.starts_at))) / (14 * 86400)))::numeric, 3),
    round(t.sim::numeric, 3),
    abs(extract(epoch from (e.starts_at - p_c.starts_at))) < 60,
    e.starts_at <> p_c.starts_at and private.occurs_at(e, p_c.starts_at)
  from public.events e
  cross join lateral (select extensions.similarity(lower(e.title), lower(p_c.title)) as sim) t
  where e.feed_id = p_c.feed_id
    and (abs(extract(epoch from (e.starts_at - p_c.starts_at))) <= 14 * 86400 or private.occurs_at(e, p_c.starts_at))
    and (t.sim >= 0.35 or (p_thread is not null and e.source_thread = p_thread and t.sim >= 0.2))
  order by 2 desc, abs(extract(epoch from (e.starts_at - p_c.starts_at)))
  limit 1
$$;

create function private.revise(p_event_id uuid, p_cause text, p_diff jsonb)
returns void
language sql volatile set search_path = ''
as $$
  insert into public.event_revisions (event_id, sequence, diff, cause, actor)
  select p_event_id, e.sequence, p_diff, p_cause, 'ai' from public.events e where e.id = p_event_id
$$;

-- Decides and (when allowed) applies one candidate. Returns the outcome.
create function private.reconcile_candidate(p_candidate_id uuid)
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
  v_allowed := c.confidence >= v_threshold and v_trusted and cardinality(c.review_reasons) = 0;
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
revoke all on function private.reconcile_candidate(uuid), private.match_candidate(public.event_candidates, text),
  private.occurs_at(public.events, timestamptz), private.thread_key(text), private.revise(uuid, text, jsonb) from public;

-- Drains the queue. Each message's candidates are handled oldest first; safe to run twice
-- (only pending candidates are touched). A message with anything left for the owner moves to
-- needs_review.
create function public.reconcile_pending(p_limit integer default 20)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  j record;
  v_c uuid;
  v_done integer := 0;
begin
  for j in select * from pgmq.read('reconcile_message', 60, least(greatest(p_limit, 1), 100)) loop
    for v_c in select id from public.event_candidates
               where message_id = (j.message ->> 'message_id')::uuid and state = 'pending'
               order by starts_at, created_at loop
      perform private.reconcile_candidate(v_c);
      v_done := v_done + 1;
    end loop;
    update public.messages set status = 'needs_review'
      where id = (j.message ->> 'message_id')::uuid and status = 'extracted'
        and exists (select 1 from public.event_candidates where message_id = (j.message ->> 'message_id')::uuid and state = 'needs_review');
    perform pgmq.delete('reconcile_message', j.msg_id);
  end loop;
  return v_done;
end;
$$;
revoke all on function public.reconcile_pending(integer) from public, anon, authenticated;
grant execute on function public.reconcile_pending(integer) to service_role;

select cron.schedule('feedcal-reconcile', '* * * * *', $$ select public.reconcile_pending() $$);

-- ---------------------------------------------------------------- calendar output carries EXDATE
create or replace function public.feed_calendar(p_token text, p_client_ip text default null,
                                                p_user_agent text default null, p_ua_family text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed public.feeds%rowtype;
  v_salt bytea;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    return null;
  end if;
  select * into v_feed from public.feeds where feed_token_hash = private.token_hash(p_token);
  if not found then
    return null;
  end if;

  if p_client_ip is not null then
    insert into private.fetch_salts (day) values (current_date) on conflict (day) do nothing;
    select salt into v_salt from private.fetch_salts where day = current_date;
    insert into public.feed_fetch_daily (feed_id, day, client_hash, user_agent_family)
    values (v_feed.id, current_date,
            sha256(v_salt || convert_to(left(p_client_ip, 64) || '|' || left(coalesce(p_user_agent, ''), 512), 'UTF8')),
            left(p_ua_family, 40))
    on conflict do nothing;
    delete from private.fetch_salts where day < current_date - 2;
  end if;

  return jsonb_build_object(
    'feed', jsonb_build_object(
      'id', v_feed.id, 'name', v_feed.name, 'slug', v_feed.slug, 'description', v_feed.description,
      'visibility', v_feed.visibility, 'last_updated_at', v_feed.last_updated_at),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'uid', e.uid, 'title', e.title, 'description', e.description,
        'location', e.location, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'all_day', e.all_day,
        'timezone', e.timezone, 'rrule', e.rrule, 'exdates', to_jsonb(e.exdates), 'status', e.status, 'sequence', e.sequence,
        'created_at', e.created_at, 'updated_at', e.updated_at,
        'source', (select s.sender_domain from public.messages m join public.sources s on s.id = m.source_id
                   where m.id = e.source_message_id)
      ) order by e.starts_at)
      from (
        select * from public.events ev
        where ev.feed_id = v_feed.id and ev.published
          and (ev.status <> 'cancelled' or ev.updated_at > now() - interval '30 days')
        order by ev.starts_at
        limit 2000
      ) e
    ), '[]'::jsonb)
  );
end;
$$;
