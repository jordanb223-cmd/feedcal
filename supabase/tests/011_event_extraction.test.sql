-- Phase 9: extraction jobs, candidate recording (idempotent), waiting without a key, caps, RLS.
begin;
select * from no_plan();
select pgmq.purge_queue('extract_message');
select pgmq.purge_queue('reconcile_message');

insert into public.messages (id, feed_id, status, original_subject, original_sender, clean_text, reference_date) values
  ('a9000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'parsed', 'Concert', 'office@x.test',
   'The winter concert is Thursday, December 11 at 6:30 PM.', '2026-11-17T17:14:00Z');
insert into public.attachments (id, message_id, filename, mime, status) values
  ('a9100000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', 'cal.pdf', 'application/pdf', 'pending');
update public.attachments set status = 'text_layer' where id = 'a9100000-0000-4000-8000-000000000001';
insert into public.attachment_pages (attachment_id, page_index, text, text_source) values
  ('a9100000-0000-4000-8000-000000000001', 2, 'Dec 9 | Spelling bee | 1:00 PM', 'text_layer');
select pgmq.send('extract_message', '{"message_id": "a9000000-0000-4000-8000-000000000001"}');

create temp table j as select * from public.claim_extract_jobs(5, 60);
select is((select context ->> 'timezone' from j), 'America/Los_Angeles', 'the feed''s timezone is the default context');
select is((select context -> 'pages' -> 0 ->> 'text' from j), 'Dec 9 | Spelling bee | 1:00 PM', 'kept pages are in the context');
select is((select context ->> 'body' from j), 'The winter concert is Thursday, December 11 at 6:30 PM.', 'and the clean text');
set local role authenticated;
select throws_ok($$ select * from public.claim_extract_jobs() $$, '42501', null, 'only the service role claims extraction jobs');
reset role;

create temp table res as select jsonb_build_object('state', 'extracted', 'reason', null, 'model', 'claude-haiku-5-5', 'calls', '[]'::jsonb, 'rejected', '[]'::jsonb,
  'candidates', jsonb_build_array(
    jsonb_build_object('title', 'Winter concert', 'starts_at', '2026-12-12T02:30:00Z', 'ends_at', null, 'all_day', false, 'timezone', 'America/Los_Angeles',
      'location', 'Gym', 'description', null, 'recurrence', null, 'status', 'new', 'confidence', 0.92, 'evidence_quote', 'Thursday, December 11 at 6:30 PM',
      'source_ref', jsonb_build_object('kind', 'body', 'attachment_id', null, 'page_index', null), 'review', '[]'::jsonb, 'from_transcription', false),
    jsonb_build_object('title', 'Spelling bee', 'starts_at', '2026-12-09T21:00:00Z', 'ends_at', null, 'all_day', false, 'timezone', 'America/Los_Angeles',
      'location', null, 'description', null, 'recurrence', null, 'status', 'new', 'confidence', 0.6, 'evidence_quote', 'Dec 9 | Spelling bee | 1:00 PM',
      'source_ref', jsonb_build_object('kind', 'page', 'attachment_id', 'a9100000-0000-4000-8000-000000000001', 'page_index', 2),
      'review', '["low_confidence"]'::jsonb, 'from_transcription', false))) as r;

select is((select public.record_extraction('a9000000-0000-4000-8000-000000000001', r) from res), 2, 'two candidates recorded');
select is((select public.record_extraction('a9000000-0000-4000-8000-000000000001', r) from res), 2, 'recording again replaces them');
select is((select count(*)::int from public.event_candidates where message_id = 'a9000000-0000-4000-8000-000000000001'), 2, '...no duplicates');
select is((select status from public.messages where id = 'a9000000-0000-4000-8000-000000000001'), 'extracted', 'the message moves to extracted');
select is((select attachment_id from public.event_candidates where title = 'Spelling bee'), 'a9100000-0000-4000-8000-000000000001'::uuid, 'a page source links to its attachment');
select is((select review_reasons from public.event_candidates where title = 'Spelling bee'), array['low_confidence'], 'review reasons are kept');
select ok((select count(*) from pgmq.q_reconcile_message) >= 1, 'then the message goes to the reconciler');
select is(public.record_extraction('a9000000-0000-4000-8000-000000000001', '{"state": "needs_review", "reason": "possible_injection", "candidates": []}'), 0,
  'a later run that needs review');
select is((select status from public.messages where id = 'a9000000-0000-4000-8000-000000000001'), 'needs_review', 'moves the message to needs_review');

-- Waiting without an API key, then re-queued.
insert into public.messages (id, feed_id, status, clean_text) values ('a9000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'parsed', 'x');
select public.record_extraction_waiting('a9000000-0000-4000-8000-000000000002', 'no_api_key');
select is((select extraction ->> 'state' from public.messages where id = 'a9000000-0000-4000-8000-000000000002'), 'waiting', 'a message waits without a key');
select ok(public.requeue_waiting_extractions() >= 1, 'waiting messages can be sent back through');

-- Caps and access (re-record the two candidates first; the needs_review run above replaced them).
select public.record_extraction('a9000000-0000-4000-8000-000000000001', r) from res;
select is(public.take_quota('bbbbbbbb-0000-4000-8000-000000000001', 'ai_calls', 100), 60, 'at most 60 AI calls a day per owner');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.event_candidates where message_id = 'a9000000-0000-4000-8000-000000000001'), 0, 'a stranger cannot see candidates');
reset role;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.event_candidates where message_id = 'a9000000-0000-4000-8000-000000000001'), 2, 'the owner can');
select throws_ok($$ update public.feeds set timezone = 'Not a zone!' where id = 'aaaaaaaa-0000-4000-8000-000000000001' $$, '23514', null, 'feed timezones are checked');
reset role;

select ok(exists (select 1 from cron.job where jobname = 'feedcal-extract-events'), 'extraction runs every minute');
select * from finish();
rollback;
