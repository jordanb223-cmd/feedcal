-- D76: reading the same email again never adds a second copy of an event or a review card.
begin;
select * from no_plan();
select pgmq.purge_queue('reconcile_message');
delete from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001';

insert into public.messages (id, feed_id, source_id, status, original_subject, clean_text) values
  ('d3200000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'parsed', 'Newsletter', 'x');

create function pg_temp.cand(p_title text, p_start timestamptz, p_conf numeric default 0.6, p_kind text default 'new', p_review jsonb default '[]')
returns jsonb language sql as $$
  select jsonb_build_object('title', p_title, 'starts_at', p_start, 'ends_at', null, 'all_day', true, 'timezone', 'America/Los_Angeles',
    'location', null, 'description', null, 'recurrence', null, 'status', p_kind, 'confidence', p_conf, 'evidence_quote', 'quoted ' || p_title,
    'source_ref', jsonb_build_object('kind', 'body', 'attachment_id', null, 'page_index', null), 'review', p_review, 'from_transcription', false) $$;
create function pg_temp.read(variadic p_cands jsonb[]) returns void language plpgsql as $$
begin
  perform public.record_extraction('d3200000-0000-4000-8000-000000000001',
    jsonb_build_object('state', 'extracted', 'reason', null, 'model', 'm', 'calls', '[]'::jsonb, 'rejected', '[]'::jsonb, 'candidates', to_jsonb(p_cands)));
  perform public.reconcile_pending(100);
  -- This whole test is one transaction, so now() never moves. In real use each read is its own
  -- transaction; stand in for that by ageing this read's decisions before the next one.
  update public.event_candidates set decided_at = decided_at - interval '1 minute' where message_id = 'd3200000-0000-4000-8000-000000000001';
end $$;
create function pg_temp.events() returns integer language sql as $$
  select count(*)::int from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$;
create function pg_temp.ev(p_like text) returns public.events language sql as $$
  select * from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001' and title ilike p_like order by created_at limit 1 $$;

-- First read: a draft (60%, date not proven), a published event (95%), and two practices with the same name.
select pg_temp.read(
  pg_temp.cand('No school (Thanksgiving)', '2026-11-26 20:00+00'),
  pg_temp.cand('Christmas musical', '2026-12-18 20:00+00', 0.95),
  pg_temp.cand('Soccer practice', '2026-12-01 20:00+00', 0.95),
  pg_temp.cand('Soccer practice', '2026-12-03 20:00+00', 0.95));
select is(pg_temp.events(), 4, 'first read: four events, and two practices with the same name stay two');
select is((pg_temp.ev('No school%')).published, false, 'the unsure one is a draft');

-- Second read of the same email: reworded, and one date differs.
select pg_temp.read(
  pg_temp.cand('No school - Thanksgiving', '2026-11-27 20:00+00'),
  pg_temp.cand('Dino Christmas Musical', '2026-12-18 20:00+00', 0.95),
  pg_temp.cand('Soccer practice', '2026-12-01 20:00+00', 0.95),
  pg_temp.cand('Soccer practice', '2026-12-03 20:00+00', 0.95));
select is(pg_temp.events(), 4, 'second read of the same email adds nothing');
select is((pg_temp.ev('No school%')).title, 'No school - Thanksgiving', 'the undecided draft takes the newer reading');
select is(((pg_temp.ev('No school%')).starts_at at time zone 'UTC')::date, '2026-11-27'::date, 'including its date');
select is((pg_temp.ev('%musical%')).title, 'Christmas musical', 'a published event is left exactly as it was');
select is((select count(distinct event_id)::int from public.event_candidates where message_id = 'd3200000-0000-4000-8000-000000000001'
           and title = 'Soccer practice' and decided_at = (select max(decided_at) from public.event_candidates where message_id = 'd3200000-0000-4000-8000-000000000001')),
  2, 'each practice matched its own event');

-- Third read is now sure about the draft: it is published in place, not copied.
select pg_temp.read(pg_temp.cand('No school - Thanksgiving', '2026-11-27 20:00+00', 0.95));
select is(pg_temp.events(), 4, 'still four');
select is((pg_temp.ev('No school%')).published, true, 'a draft the newer reading is sure about is published in place');

-- The owner discards a draft; a re-read must not bring it back.
select pg_temp.read(pg_temp.cand('Bake sale', '2026-12-05 20:00+00'));
select is(pg_temp.events(), 5, 'a new draft appears');
update public.events set status = 'cancelled' where id = (pg_temp.ev('Bake sale')).id;  -- what discard_draft does
select pg_temp.read(pg_temp.cand('Bake sale!', '2026-12-05 20:00+00'));
select is(pg_temp.events(), 5, 'a discarded draft is not recreated');
select is((pg_temp.ev('Bake sale%')).status, 'cancelled', 'and stays discarded');

-- A review card nobody decided is replaced, not stacked; a rejected one stays rejected.
select pg_temp.read(pg_temp.cand('Christmas musical', '2026-12-19 20:00+00', 0.6, 'changed'));
select is((select count(*)::int from public.event_candidates where message_id = 'd3200000-0000-4000-8000-000000000001' and state = 'needs_review'), 0,
  'a "changed" reading of an event this email itself produced is that event again, not a change card');
insert into public.event_candidates (message_id, feed_id, title, starts_at, all_day, timezone, change_kind, confidence, evidence_quote, source_kind, state, reject_reason, decided_at)
values ('d3200000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Pajama day', '2026-12-10 20:00+00', true, 'America/Los_Angeles', 'new', 0.9, 'quoted Pajama day', 'body', 'rejected', 'not_an_event', now() - interval '1 hour');
select pg_temp.read(pg_temp.cand('Pajama Day', '2026-12-10 20:00+00', 0.95));
select is(pg_temp.events(), 5, 'something the owner rejected from this email does not come back');

-- Another email about the same event still goes through the normal matching.
insert into public.messages (id, feed_id, source_id, status, original_subject, clean_text) values
  ('d3200000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'parsed', 'Reminder', 'x');
select public.record_extraction('d3200000-0000-4000-8000-000000000002', jsonb_build_object('state', 'extracted', 'reason', null, 'model', 'm', 'calls', '[]'::jsonb, 'rejected', '[]'::jsonb,
  'candidates', jsonb_build_array(pg_temp.cand('Field trip', '2026-12-15 20:00+00', 0.95))));
select public.reconcile_pending(100);
select is(pg_temp.events(), 6, 'a different email can still add a new event');

select * from finish();
rollback;
