-- D60: a job whose worker keeps dying (never reaching its failure handler) is given up after 5
-- reads instead of coming back forever; healthy jobs read with it still come through.
begin;
select * from no_plan();
select pgmq.purge_queue('process_message');
select pgmq.purge_queue('extract_message');

insert into public.messages (id, feed_id, status) values
  ('99999999-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'received'),
  ('99999999-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'received'),
  ('99999999-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'parsed');
select pgmq.send('process_message', '{"message_id": "99999999-0000-4000-8000-000000000001"}');
select pgmq.send('process_message', '{"message_id": "99999999-0000-4000-8000-000000000002"}');
select pgmq.send('extract_message', '{"message_id": "99999999-0000-4000-8000-000000000003"}');
-- Simulate five reads whose workers were killed: read 5 times, now visible again.
update pgmq.q_process_message set read_ct = 5, vt = clock_timestamp() - interval '1 second' where message ->> 'message_id' = '99999999-0000-4000-8000-000000000001';
update pgmq.q_extract_message set read_ct = 5, vt = clock_timestamp() - interval '1 second';

select is((select count(*)::int from public.claim_process_jobs(5, 60) where message_id = '99999999-0000-4000-8000-000000000001'), 0, 'the crashed job is not handed out again');
select is((select status from public.messages where id = '99999999-0000-4000-8000-000000000001'), 'failed', 'its message is marked failed');
select is((select count(*)::int from pgmq.q_process_message where message ->> 'message_id' = '99999999-0000-4000-8000-000000000001'), 0, 'its job left the queue (archived)');
select is((select count(*)::int from pgmq.a_process_message where message ->> 'message_id' = '99999999-0000-4000-8000-000000000001'), 1, 'and is kept in the archive');
select is((select status from public.messages where id = '99999999-0000-4000-8000-000000000002'), 'received', 'a healthy message is untouched');
select is((select count(*)::int from pgmq.q_process_message where message ->> 'message_id' = '99999999-0000-4000-8000-000000000002'), 1, 'and its job is still queued');

select is((select count(*)::int from public.claim_extract_jobs(5, 60)), 0, 'the crashed extraction job is not handed out again');
select is((select status from public.messages where id = '99999999-0000-4000-8000-000000000003'), 'failed', 'its message is marked failed');

select throws_ok($$ select private.give_up_crashed_jobs('messages; drop table public.feeds') $$, 'P0001', 'unknown queue messages; drop table public.feeds', 'only the three queues are accepted');
select is((select has_function_privilege('anon', 'private.give_up_crashed_jobs(text)', 'execute')), false, 'not callable from outside');

select * from finish();
rollback;
