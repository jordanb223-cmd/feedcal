-- D76: reading the same email again must not add a second copy of anything.
--
-- Before: each read was reconciled as if it were a new email. The model words things a little
-- differently each time ("No school (Thanksgiving)" on the 26th, then "No school - Thanksgiving"
-- on the 27th), so a re-read left extra drafts and extra review cards behind.
--
-- Now a re-read can only refine what that same email produced before:
--   1. review cards from the earlier read that nobody decided are dropped (record_extraction);
--   2. a candidate that looks like an event this email already produced is that event again:
--        an undecided draft takes the newer reading (and is published if it now qualifies);
--        a published event, or a draft the owner discarded, is left exactly as it is;
--   3. a candidate that looks like one the owner rejected from this email stays rejected.
-- "Looks like" = titles at least half alike, or the same start with titles a fifth alike.
-- Events claimed earlier in the same read are skipped, so two real events with similar names
-- ("Practice" on Tuesday and on Thursday) are never folded into one.

do $$
declare
  f record;
  n integer := 0;
  v_anchor text := '  select * into m from private.match_candidate(c, v_thread);';
  v_block text := $block$
  -- D76: is this an event the same email already produced on an earlier read?
  declare
    v_read_at timestamptz := coalesce((select (msg.extraction ->> 'at')::timestamptz from public.messages msg where msg.id = c.message_id), '-infinity');
    s public.events%rowtype;
  begin
    select ev.* into s from public.events ev
      cross join lateral (select extensions.similarity(lower(ev.title), lower(c.title)) as sim) t
      where ev.feed_id = c.feed_id and ev.source_message_id = c.message_id
        and (t.sim >= 0.5 or (abs(extract(epoch from (ev.starts_at - c.starts_at))) < 60 and t.sim >= 0.2))
        and not exists (select 1 from public.event_candidates k
                        where k.message_id = c.message_id and k.event_id = ev.id and k.id <> c.id and k.decided_at >= v_read_at)
      order by (abs(extract(epoch from (ev.starts_at - c.starts_at))) < 60) desc, t.sim desc, ev.created_at
      limit 1;
    if found then
      if not s.published and s.status = 'tentative' and c.change_kind <> 'cancelled' then
        update public.events set title = c.title, description = c.description, location = coalesce(c.location, location),
          starts_at = c.starts_at, ends_at = c.ends_at, all_day = c.all_day, timezone = c.timezone, rrule = c.rrule,
          confidence = c.confidence, evidence_quote = c.evidence_quote, updated_at = now(),
          status = case when v_allowed then 'confirmed' else 'tentative' end, published = v_allowed
          where id = s.id;
        if v_allowed then
          perform private.revise(s.id, 'extracted', jsonb_build_object('candidate', c.id, 'published', true, 'reread', true));
        end if;
      end if;
      update public.event_candidates set outcome = 'duplicate', event_id = s.id, decided_at = now(), state = 'applied' where id = c.id;
      return 'duplicate';
    end if;
    if exists (select 1 from public.event_candidates k
               where k.message_id = c.message_id and k.state = 'rejected' and k.id <> c.id
                 and (extensions.similarity(lower(k.title), lower(c.title)) >= 0.5
                      or (abs(extract(epoch from (k.starts_at - c.starts_at))) < 60 and extensions.similarity(lower(k.title), lower(c.title)) >= 0.2))) then
      update public.event_candidates set outcome = 'duplicate', decided_at = now(), state = 'applied' where id = c.id;
      return 'duplicate';
    end if;
  end;
$block$;
begin
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'private' and p.proname = 'reconcile_candidate' and p.prokind = 'f'
      and position(v_anchor in pg_get_functiondef(p.oid)) > 0
  loop
    execute replace(f.def, v_anchor, v_block || v_anchor);
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception 're-read: expected to change reconcile_candidate once, changed % functions', n;
  end if;

  n := 0;
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'record_extraction' and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%where message_id = p_message_id and state = ''pending'';%'
  loop
    execute replace(f.def, 'where message_id = p_message_id and state = ''pending'';',
                           'where message_id = p_message_id and state in (''pending'', ''needs_review'');');
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception 're-read: expected to change record_extraction once, changed % functions', n;
  end if;

  -- A picture already found to be blank is not read again on a retry (triage checks this flag).
  n := 0;
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'claim_triage_jobs' and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%''owner_never'', coalesce(a.triage ->> ''reason'', '''') = ''owner_never'',%'
  loop
    execute replace(f.def, '''owner_never'', coalesce(a.triage ->> ''reason'', '''') = ''owner_never'',',
      '''owner_never'', coalesce(a.triage ->> ''reason'', '''') = ''owner_never'', ''blank_before'', coalesce(a.triage ->> ''reason'', '''') = ''no_text_on_page'',');
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception 're-read: expected to change claim_triage_jobs once, changed % functions', n;
  end if;
end;
$$;
