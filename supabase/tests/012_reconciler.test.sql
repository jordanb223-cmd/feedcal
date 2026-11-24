-- Phase 10: the reconciler's outcomes, from the build plan's list of cases.
begin;
select * from no_plan();
select pgmq.purge_queue('reconcile_message');
-- Start Alice's public feed empty, so seed events don't match.
delete from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- A message from the trusted seed sender (office@school.example.test), and one from a stranger.
create function pg_temp.msg(p_subject text, p_trusted boolean default true) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.messages (id, feed_id, source_id, status, original_subject)
  values (v, 'aaaaaaaa-0000-4000-8000-000000000001', case when p_trusted then 'cccccccc-0000-4000-8000-000000000001'::uuid end, 'extracted', p_subject);
  return v;
end $$;
create function pg_temp.cand(p_msg uuid, p_title text, p_local text, p_kind text default 'new', p_conf numeric default 0.92,
                             p_location text default null, p_rrule text default null, p_review text[] default '{}') returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.event_candidates (id, message_id, feed_id, title, starts_at, all_day, timezone, location, rrule, change_kind, confidence,
                                       evidence_quote, source_kind, review_reasons)
  values (v, p_msg, 'aaaaaaaa-0000-4000-8000-000000000001', p_title, (p_local::timestamp at time zone 'America/Los_Angeles'), false,
          'America/Los_Angeles', p_location, p_rrule, p_kind, p_conf, 'quoted text ' || p_title, 'body', p_review);
  perform pgmq.send('reconcile_message', jsonb_build_object('message_id', p_msg));
  return v;
end $$;
create function pg_temp.run() returns integer language sql as $$ select public.reconcile_pending(100) $$;
create function pg_temp.outcome(p uuid) returns text language sql as $$ select outcome || '/' || state from public.event_candidates where id = p $$;
create function pg_temp.events(p_title text) returns integer language sql as $$
  select count(*)::int from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001' and title ilike p_title $$;

-- ---------------------------------------------------------------- the same event in 3 emails
create temp table c1 as select pg_temp.cand(pg_temp.msg('Winter concert'), 'Winter concert', '2026-12-11 18:30', 'new', 0.92, 'Gym') as id;
create temp table c2 as select pg_temp.cand(pg_temp.msg('Fwd: Winter concert'), 'Winter Concert', '2026-12-11 18:30') as id;
create temp table c3 as select pg_temp.cand(pg_temp.msg('Reminder: concert Thursday'), 'Winter concert reminder', '2026-12-11 18:30') as id;
select is(pg_temp.run(), 3, 'three candidates handled');
select is(pg_temp.events('winter concert%'), 1, 'the same event in three emails is one event');
select is((select array_agg(pg_temp.outcome(id)) from (select id from c1 union all select id from c2 union all select id from c3) t),
  array['new/applied', 'duplicate/applied', 'duplicate/applied'], 'new, then duplicate, duplicate');
select is((select published from public.events where title = 'Winter concert'), true, 'trusted + confident is published automatically');
select is((select count(*)::int from public.event_revisions r join public.events e on e.id = r.event_id where e.title = 'Winter concert'), 1, 'one revision: extracted');

-- ---------------------------------------------------------------- time change
select pg_temp.cand(pg_temp.msg('Practice'), 'Friday practice', '2026-11-20 17:00');
select pg_temp.run();
create temp table t1 as select id, sequence from public.events where title = 'Friday practice';
create temp table ch as select pg_temp.cand(pg_temp.msg('Re: Practice'), 'Friday practice', '2026-11-20 18:00', 'changed') as id;
select pg_temp.run();
select is(pg_temp.outcome((select id from ch)), 'update/applied', 'a time change is an update');
select is((select starts_at from public.events where id = (select id from t1)), '2026-11-20 18:00 America/Los_Angeles'::timestamptz, 'the event moves to 6 PM');
select is((select sequence from public.events where id = (select id from t1)), (select sequence + 1 from t1), 'SEQUENCE goes up, so calendars take the change');
select is((select cause from public.event_revisions where event_id = (select id from t1) order by id desc limit 1), 'matched_update', 'a matched_update revision is written');
select is((select diff -> 'starts_at' ->> 1 from public.event_revisions where event_id = (select id from t1) order by id desc limit 1)::timestamptz,
  '2026-11-20 18:00 America/Los_Angeles'::timestamptz, 'the revision holds before and after');
select is(pg_temp.events('friday practice'), 1, 'still one event');

-- ---------------------------------------------------------------- date move
select pg_temp.cand(pg_temp.msg('Conferences'), 'Parent conferences', '2026-11-24 15:30');
select pg_temp.run();
create temp table dm as select pg_temp.cand(pg_temp.msg('Conferences moved'), 'Parent conferences', '2026-12-01 15:30', 'changed') as id;
select pg_temp.run();
select is(pg_temp.outcome((select id from dm)), 'update/applied', 'a date move is an update');
select is((select starts_at::date from public.events where title = 'Parent conferences'), '2026-12-01'::date, 'the event moved a week');

-- ---------------------------------------------------------------- cancellation (kept 30 days)
select pg_temp.cand(pg_temp.msg('Game'), 'Game vs Comets', '2026-11-22 09:00');
select pg_temp.run();
create temp table cx as select pg_temp.cand(pg_temp.msg('Game cancelled'), 'Game vs Comets', '2026-11-22 09:00', 'cancelled') as id;
select pg_temp.run();
select is(pg_temp.outcome((select id from cx)), 'cancel/applied', 'a cancellation is applied');
select is((select status from public.events where title = 'Game vs Comets'), 'cancelled', 'the event is cancelled, not deleted');
select is((select diff ->> 'evidence_quote' from public.event_revisions r join public.events e on e.id = r.event_id
           where e.title = 'Game vs Comets' and r.cause = 'cancelled'), 'quoted text Game vs Comets', 'the evidence quote is recorded');

-- ---------------------------------------------------------------- rain date (unsure) goes to review
select pg_temp.cand(pg_temp.msg('Walkathon'), 'Walkathon', '2026-11-22 10:00');
select pg_temp.run();
create temp table rd as select pg_temp.cand(pg_temp.msg('Walkathon rain plan'), 'Walkathon', '2026-11-23 10:00', 'changed', 0.40) as id;  -- below the 45% bar (D85)
select pg_temp.run();
select is(pg_temp.outcome((select id from rd)), 'update/needs_review', 'a rain date (low confidence) waits for the owner');
select is((select starts_at::date from public.events where title = 'Walkathon'), '2026-11-22'::date, 'and changes nothing yet');
select is((select status from public.messages where id = (select message_id from public.event_candidates where id = (select id from rd))), 'needs_review',
  'its message shows as needing review');

-- ---------------------------------------------------------------- recurring practice with EXDATE
select pg_temp.cand(pg_temp.msg('Practice schedule'), 'Team practice', '2026-12-01 17:00', 'new', 0.92, null, 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261222');
select pg_temp.run();
create temp table ex as select pg_temp.cand(pg_temp.msg('No practice Dec 8'), 'Team practice', '2026-12-08 17:00', 'cancelled') as id;
select pg_temp.run();
select is(pg_temp.outcome((select id from ex)), 'exdate/applied', 'cancelling one practice of a series is an EXDATE');
select is((select exdates from public.events where title = 'Team practice'), array['2026-12-08 17:00 America/Los_Angeles'::timestamptz], 'that date is excluded');
select is((select status from public.events where title = 'Team practice'), 'confirmed', 'the series itself stays');
select is((select sequence from public.events where title = 'Team practice'), 1, 'and its SEQUENCE goes up');
create temp table occ as select pg_temp.cand(pg_temp.msg('Practice Tuesday'), 'Team practice', '2026-12-15 17:00') as id;
select pg_temp.run();
select is(pg_temp.outcome((select id from occ)), 'duplicate/applied', 'a single later practice is recognised as part of the series');

-- ---------------------------------------------------------------- conflict, untrusted, idempotency
create temp table cf as select pg_temp.cand(pg_temp.msg('Concert time'), 'Winter concert', '2026-12-11 19:30') as id;
select pg_temp.run();
select is(pg_temp.outcome((select id from cf)), 'conflict/needs_review', 'same day, different time, not stated as a change: conflict');
create temp table un as select pg_temp.cand(pg_temp.msg('Bake sale', false), 'Bake sale', '2026-11-21 09:00') as id;
select pg_temp.run();
select is((select row(published, status)::text from public.events where title = 'Bake sale'), row(false, 'tentative')::text,
  'an untrusted sender''s event is a draft, not published');
create temp table before as select count(*) as n from public.events;
select is(pg_temp.run(), 0, 'running again does nothing');
select is((select count(*) from public.events), (select n from before), 'no events added or deleted');
select ok(exists (select 1 from cron.job where jobname = 'feedcal-reconcile'), 'the reconciler runs every minute');

-- ---------------------------------------------------------------- the calendar carries the EXDATE
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.tok', public.rotate_feed_token('aaaaaaaa-0000-4000-8000-000000000001'), true);
reset role;
select is(jsonb_array_length((select e -> 'exdates' from jsonb_array_elements(public.feed_calendar(current_setting('test.tok')) -> 'events') e
          where e ->> 'title' = 'Team practice')), 1, 'feed_calendar returns the excluded date');

select * from finish();
rollback;
