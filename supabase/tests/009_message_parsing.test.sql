-- Phase 7 job plumbing: claim, record (idempotent), ignore empty, give up after 5 failures.
begin;
select * from no_plan();

-- Clear anything earlier tests or seed left on the queue, inside this transaction.
select pgmq.purge_queue('process_message');

insert into public.messages (id, feed_id, status, storage_path, sender) values
  ('99000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'received', 'p/one.eml', 'a@x.test'),
  ('99000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'received', 'p/two.eml', 'b@x.test'),
  ('99000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'received', 'p/three.eml', 'c@x.test');
insert into public.messages (id, feed_id, status, storage_path, sender, quarantine_reason) values
  ('99000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'received', 'p/four.eml', 'd@x.test', 'new_sender');
select pgmq.send('process_message', jsonb_build_object('message_id', '99000000-0000-4000-8000-000000000001'));
select pgmq.send('process_message', jsonb_build_object('message_id', '99000000-0000-4000-8000-000000000002'));

-- Only the service role can touch the queue functions.
set local role authenticated;
select throws_ok($$ select * from public.claim_process_jobs() $$, '42501', null, 'a signed-in user cannot claim jobs');
reset role;
set local role anon;
select throws_ok($$ select public.record_parsed_message(gen_random_uuid(), '{}', '[]') $$, '42501', null, 'anon cannot record a parse');
reset role;

create temp table jobs as select * from public.claim_process_jobs(10, 60);
select is((select count(*)::int from jobs), 2, 'both queued messages are claimed');
select is((select storage_path from jobs where message_id = '99000000-0000-4000-8000-000000000001'), 'p/one.eml', 'a job carries the raw file path');
select is((select count(*)::int from public.claim_process_jobs(10, 60)), 0, 'claimed jobs are hidden from other workers');

-- Record a parse with one attachment, twice.
create temp table parsed as select jsonb_build_object(
  'referenceDate', '2026-11-17T17:14:00.000Z', 'referenceDateSource', 'forwarded_header',
  'sender', jsonb_build_object('address', 'dana@riverleague.example.test', 'name', 'Coach Dana'),
  'subject', 'Practice schedule', 'cleanText', 'Practices are Tuesdays at 5 PM.', 'strippedText', '> old',
  'language', 'en', 'forwardNotes', '["Can you add these?"]'::jsonb, 'forwardDepth', 1, 'bodySource', 'text', 'discarded', '[]'::jsonb) as j;
create temp table att as select jsonb_build_array(jsonb_build_object(
  'filename', 'schedule.pdf', 'mime', 'application/pdf', 'bytes', 1234, 'sha256', repeat('ab', 32),
  'storage_path', 'aaaaaaaa-0000-4000-8000-000000000001/99000000-0000-4000-8000-000000000001/' || repeat('ab', 32),
  'inline', false, 'contentId', null, 'width', null, 'height', null)) as j;

select is((select public.record_parsed_message('99000000-0000-4000-8000-000000000001', parsed.j, att.j) from parsed, att), 'parsed', 'a parse is recorded');
select is((select public.record_parsed_message('99000000-0000-4000-8000-000000000001', parsed.j, att.j) from parsed, att), 'parsed', 'recording again is harmless');
select is((select count(*)::int from public.attachments where message_id = '99000000-0000-4000-8000-000000000001'), 1, '...and adds no duplicate attachment');
select is((select row(status, original_sender, original_subject, clean_text, language, reference_date_source)::text from public.messages where id = '99000000-0000-4000-8000-000000000001'),
  row('parsed', 'dana@riverleague.example.test', 'Practice schedule', 'Practices are Tuesdays at 5 PM.', 'en', 'forwarded_header')::text, 'the message holds the parse');
select is((select parse_details -> 'forwardNotes' ->> 0 from public.messages where id = '99000000-0000-4000-8000-000000000001'), 'Can you add these?', 'forward notes are kept');
select is((select status from public.attachments where message_id = '99000000-0000-4000-8000-000000000001'), 'pending', 'attachments wait for Phase 8');

select is(public.record_parsed_message('99000000-0000-4000-8000-000000000002', '{"cleanText": "  ", "language": "und", "referenceDate": "2026-11-17T00:00:00Z"}', '[]'), 'ignored',
  'an email with no text and no attachments is ignored');
select is(public.record_parsed_message('99000000-0000-4000-8000-000000000004', (select j from parsed), '[]'), 'quarantined',
  'a quarantined message is never parsed');
select is(public.finish_process_job((select job_id from jobs where message_id = '99000000-0000-4000-8000-000000000001')), true, 'a finished job leaves the queue');

-- Failures: retry four times, then give up.
select pgmq.send('process_message', jsonb_build_object('message_id', '99000000-0000-4000-8000-000000000003'));
create temp table j3 as select job_id from public.claim_process_jobs(1, 60);
select is(public.fail_process_job((select job_id from j3), '99000000-0000-4000-8000-000000000003'), 'retry', 'first failure: retry');
select public.fail_process_job((select job_id from j3), '99000000-0000-4000-8000-000000000003') from generate_series(1, 3);
select is(public.fail_process_job((select job_id from j3), '99000000-0000-4000-8000-000000000003'), 'failed', 'fifth failure: give up');
select is((select status from public.messages where id = '99000000-0000-4000-8000-000000000003'), 'failed', 'the message is marked failed');
select is((select count(*)::int from pgmq.q_process_message where msg_id = (select job_id from j3)), 0, 'its job leaves the queue (archived)');

-- Expiry reaches attachment files too.
delete from public.messages where id = '99000000-0000-4000-8000-000000000001';
select ok(exists (select 1 from private.storage_trash where bucket = 'attachments' and path like '%/' || repeat('ab', 32)),
  'deleting a message queues its attachment files for deletion');

select is((select public from storage.buckets where id = 'attachments'), false, 'the attachments bucket is private');
select ok(exists (select 1 from cron.job where jobname = 'feedcal-process-messages' and schedule = '* * * * *'), 'parsing runs every minute');

select * from finish();
rollback;
