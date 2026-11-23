-- D69: waiting emails are retried on their own; imported repeating events keep their rule, skip
-- removed dates, and stay on the public page until their last coming date.
begin;
select * from no_plan();

-- ---------------------------------------------------------------- waiting emails
select is((select schedule from cron.job where jobname = 'feedcal-requeue-waiting'), '37 * * * *', 'waiting emails are sent back every hour');
insert into public.messages (id, feed_id, status, clean_text) values ('d3000000-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-000000000001', 'parsed', 'x');
select public.record_extraction_waiting('d3000000-0000-4000-8000-000000000009', 'daily_ai_limit');
select public.requeue_waiting_extractions();
select is((select count(*)::int from pgmq.q_extract_message where message ->> 'message_id' = 'd3000000-0000-4000-8000-000000000009'), 1, 'a waiting email is queued again');
select public.requeue_waiting_extractions();
select is((select count(*)::int from pgmq.q_extract_message where message ->> 'message_id' = 'd3000000-0000-4000-8000-000000000009'), 1,
  'an email already back in the queue is not queued twice');

-- ---------------------------------------------------------------- imported repeating events
insert into public.feeds (id, owner_id, name, slug, visibility, import_url, import_mode)
  values ('d3000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Chess', 'chess-audit-x', 'public', 'https://cal.example.org/c.ics', 'daily');
set local role service_role;
select is(public.record_import('d3000000-0000-4000-8000-000000000001', jsonb_build_array(
  jsonb_build_object('uid', 'chess@club', 'title', 'Chess club', 'starts_at', now() - interval '60 days', 'ends_at', now() - interval '60 days' + interval '1 hour',
    'timezone', 'America/Los_Angeles', 'rrule', 'FREQ=WEEKLY',
    'exdates', jsonb_build_array(now() + interval '3 days'),
    'occurrences', jsonb_build_array(now() + interval '10 days', now() + interval '17 days')),
  jsonb_build_object('uid', 'chess@club#moved', 'title', 'Chess club (moved)', 'starts_at', now() + interval '4 days', 'timezone', 'America/Los_Angeles'),
  jsonb_build_object('uid', 'ended@club', 'title', 'Ended series', 'starts_at', now() - interval '90 days', 'timezone', 'America/Los_Angeles', 'rrule', 'FREQ=WEEKLY;COUNT=2')
)), 3, 'a series, one changed date and an ended series are imported as three events');
reset role;
select is((select array[cardinality(exdates), cardinality(occurrences)] from public.events where feed_id = 'd3000000-0000-4000-8000-000000000001' and external_uid = 'chess@club'),
  array[1, 2], 'removed dates and coming dates are stored with the series');
select is((select rrule from public.events where feed_id = 'd3000000-0000-4000-8000-000000000001' and external_uid = 'chess@club'), 'FREQ=WEEKLY',
  'the changed date did not overwrite the series');

set local role anon;
select is((select jsonb_agg(e ->> 'title' order by e ->> 'starts_at') from jsonb_array_elements(public.public_feed_page('chess-audit-x') -> 'events') e),
  '["Chess club (moved)", "Chess club"]'::jsonb, 'the public page lists the changed date and the series; the ended series is gone');
select ok((select (e ->> 'starts_at')::timestamptz > now() + interval '9 days' and (e ->> 'repeats')::boolean
           from jsonb_array_elements(public.public_feed_page('chess-audit-x') -> 'events') e where e ->> 'title' = 'Chess club'),
  'a series that began in the past shows at its next coming date, marked as repeating');
select ok((select ((e ->> 'ends_at')::timestamptz - (e ->> 'starts_at')::timestamptz) = interval '1 hour'
           from jsonb_array_elements(public.public_feed_page('chess-audit-x') -> 'events') e where e ->> 'title' = 'Chess club'),
  'and keeps its length');
select is((select (e ->> 'repeats')::boolean from jsonb_array_elements(public.public_feed_page('chess-audit-x') -> 'events') e where e ->> 'title' = 'Chess club (moved)'),
  false, 'a single event is not marked as repeating');
reset role;

select * from finish();
rollback;
