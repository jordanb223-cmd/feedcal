-- Phase 8: triage hand-off, recording, owner feedback (rules), daily caps, file access.
begin;
select * from no_plan();
select pgmq.purge_queue('process_message');
select pgmq.purge_queue('triage_message');
select pgmq.purge_queue('extract_message');

-- A message from Alice's trusted sender (seed source cccc…01) with two PDFs.
insert into public.messages (id, feed_id, source_id, status, storage_path) values
  ('a8000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'received', 'r/1.eml');
select is(public.record_parsed_message('a8000000-0000-4000-8000-000000000001',
  '{"cleanText": "See attached", "language": "en", "referenceDate": "2026-11-17T00:00:00Z"}',
  jsonb_build_array(
    jsonb_build_object('filename', 'newsletter.pdf', 'mime', 'application/pdf', 'bytes', 1000, 'sha256', repeat('11', 32), 'storage_path', 'aaaaaaaa-0000-4000-8000-000000000001/a8000000-0000-4000-8000-000000000001/11'),
    jsonb_build_object('filename', 'Schedule-Week-47.pdf', 'mime', 'application/pdf', 'bytes', 2000, 'sha256', repeat('22', 32), 'storage_path', 'aaaaaaaa-0000-4000-8000-000000000001/a8000000-0000-4000-8000-000000000001/22'))),
  'parsed', 'parsing records the message');
select is((select count(*)::int from pgmq.q_triage_message), 1, 'a parsed message goes on to triage');

-- ---------------------------------------------------------------- claim
create temp table j as select * from public.claim_triage_jobs(5, 60);
select is((select jsonb_array_length(attachments) from j), 2, 'the job carries the attachments');
select is((select attachments -> 0 ->> 'seen_before' from j), 'false', 'a new file is not "seen before"');
set local role authenticated;
select throws_ok($$ select * from public.claim_triage_jobs() $$, '42501', null, 'only the service role claims triage jobs');
reset role;

-- ---------------------------------------------------------------- record
create temp table ids as select
  (select id from public.attachments where filename = 'newsletter.pdf' and message_id = 'a8000000-0000-4000-8000-000000000001') as news,
  (select id from public.attachments where filename = 'Schedule-Week-47.pdf' and message_id = 'a8000000-0000-4000-8000-000000000001') as sched;
grant select on ids to authenticated;
select is(public.record_triage('a8000000-0000-4000-8000-000000000001', jsonb_build_array(
  jsonb_build_object('id', (select news from ids), 'status', 'text_layer', 'pages_total', 12,
    'pages', jsonb_build_array(jsonb_build_object('index', 3, 'text', 'Fri Nov 21 Picture day 8:30 AM', 'source', 'text_layer')),
    'triage', jsonb_build_object('stage', 2, 'reason', 'text_layer', 'keptPages', jsonb_build_array(3))),
  jsonb_build_object('id', (select sched from ids), 'status', 'skipped', 'pages_total', 1, 'pages', '[]'::jsonb,
    'triage', jsonb_build_object('stage', 2, 'reason', 'no_schedule_found')))), 1, 'one page kept');
select is((select row(status, pages, triage ->> 'reason')::text from public.attachments where id = (select news from ids)), row('text_layer', 12, 'text_layer')::text, 'the attachment records stage and reason');
select is((select text from public.attachment_pages where attachment_id = (select news from ids)), 'Fri Nov 21 Picture day 8:30 AM', 'the kept page text is stored');
select is((select pages_for_ai from public.messages where id = 'a8000000-0000-4000-8000-000000000001'), 1::smallint, 'the message knows how many pages go to the AI');
select is((select count(*)::int from pgmq.q_extract_message), 1, 'then it goes on to extraction');
select is(public.record_triage('a8000000-0000-4000-8000-000000000001', jsonb_build_array(
  jsonb_build_object('id', (select news from ids), 'status', 'text_layer', 'pages_total', 12,
    'pages', jsonb_build_array(jsonb_build_object('index', 3, 'text', 'Fri Nov 21 Picture day 8:30 AM', 'source', 'text_layer')),
    'triage', jsonb_build_object('stage', 2, 'reason', 'text_layer')))), 1, 'recording again replaces pages, never duplicates');
select is((select count(*)::int from public.attachment_pages where attachment_id = (select news from ids)), 1, '...still one page');

-- A failed file can be re-read successfully (through pending).
update public.attachments set status = 'failed' where id = (select sched from ids) and status = 'pending';
update public.attachments set status = 'pending' where id = (select sched from ids);
update public.attachments set status = 'failed' where id = (select sched from ids);
select lives_ok(format($$ select public.record_triage('a8000000-0000-4000-8000-000000000001', '[{"id": "%s", "status": "text_layer", "pages": [], "triage": {"stage": 2, "reason": "text_layer"}}]') $$, (select sched from ids)),
  'failed -> text_layer is recorded via pending');

-- ---------------------------------------------------------------- owner feedback
select is(private.filename_pattern('Schedule-Week-47.pdf'), '^schedule-week-\d+\.pdf$', 'a learned pattern generalises numbers');
select ok('schedule-week-48.pdf' ~ private.filename_pattern('Schedule-Week-47.pdf'), 'it matches next week''s file');
select ok(not ('newsletter.pdf' ~ private.filename_pattern('Schedule-Week-47.pdf')), 'and not other files');
select ok(private.filename_pattern('a(b).pdf') = '^a\(b\)\.pdf$', 'regex characters are escaped');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(format('select public.choose_attachment(%L)', (select sched from ids)), 'P0002', null, 'a stranger cannot choose');
select throws_ok(format('select public.never_use_attachment(%L)', (select news from ids)), 'P0002', null, 'a stranger cannot rule files out');
reset role;

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select is((select public.choose_attachment((select sched from ids)) -> 'prefer' -> 0 ->> 'pattern'), '^schedule-week-\d+\.pdf$', '"this one" learns the sender''s pattern');
reset role;
select is((select attachment_rule -> 'prefer' -> 0 ->> 'mime' from public.sources where id = 'cccccccc-0000-4000-8000-000000000001'), 'application/pdf', 'the rule is stored on the sender');
select is((select array_agg(filename || '=' || chosen order by chosen desc) from public.attachments where message_id = 'a8000000-0000-4000-8000-000000000001'),
  array['Schedule-Week-47.pdf=true', 'newsletter.pdf=false'], 'only the picked file is chosen');
select is((select count(*)::int from public.attachments where message_id = 'a8000000-0000-4000-8000-000000000001' and status = 'pending'), 2, 'the email is re-read');
select is((select count(*)::int from pgmq.q_triage_message where message ->> 'message_id' = 'a8000000-0000-4000-8000-000000000001'), 2, '...and re-queued');

set local role authenticated;
select is((select jsonb_array_length(public.never_use_attachment((select news from ids)) -> 'never')), 1, '"never use files like this" is learned');
select is(public.set_sender_large_attachments('cccccccc-0000-4000-8000-000000000001', true), true, 'the owner can allow big attachments from a sender');
reset role;
select is((select row(status, triage ->> 'reason')::text from public.attachments where id = (select news from ids)), row('skipped', 'owner_never')::text, 'the ruled-out file stops being used now');
select is((select count(*)::int from public.attachment_pages where attachment_id = (select news from ids)), 0, '...and its pages are removed');
select is((select attachment_rule ->> 'allowLarge' from public.sources where id = 'cccccccc-0000-4000-8000-000000000001'), 'true', 'big attachments allowed for that sender');
select is((select jsonb_array_length(attachment_rule -> 'prefer') from public.sources where id = 'cccccccc-0000-4000-8000-000000000001'), 1, 'the preferred pattern is kept');

-- ---------------------------------------------------------------- daily caps
select is(public.take_quota('aaaaaaaa-0000-4000-8000-000000000001', 'vision_pages', 15), 15, 'vision pages granted');
select is(public.take_quota('aaaaaaaa-0000-4000-8000-000000000001', 'vision_pages', 15), 5, 'only what is left of 20 a day');
select is(public.take_quota('aaaaaaaa-0000-4000-8000-000000000002', 'vision_pages', 1), 0, 'the cap is per owner, across their feeds');
select is(public.take_quota('bbbbbbbb-0000-4000-8000-000000000001', 'vision_pages', 1), 1, 'another owner has their own');

-- ---------------------------------------------------------------- file access for thumbnails
insert into storage.objects (bucket_id, name, owner_id) values
  ('attachments', 'aaaaaaaa-0000-4000-8000-000000000001/a8000000-0000-4000-8000-000000000001/22', null);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from storage.objects where bucket_id = 'attachments' and name like 'aaaaaaaa-0000-4000-8000-000000000001/a8000000-%'), 1, 'a member can see the feed''s files');
reset role;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from storage.objects where bucket_id = 'attachments'), 0, 'a stranger cannot');
reset role;

select ok(exists (select 1 from cron.job where jobname = 'feedcal-triage-attachments'), 'triage runs every minute');

select * from finish();
rollback;
