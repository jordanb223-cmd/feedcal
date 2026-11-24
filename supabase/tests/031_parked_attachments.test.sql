-- D71: photos and scans parked because image reading was off, or the day's limit was used up,
-- go back through on their own.
begin;
select * from no_plan();
select pgmq.purge_queue('triage_message');
select pgmq.purge_queue('extract_message');

create function pg_temp.parked(p_id uuid, p_reason text, p_triaged timestamptz default now(), p_received timestamptz default now(), p_status text default 'pending')
returns void language plpgsql as $$
begin
  insert into public.messages (id, feed_id, source_id, status, storage_path, received_at)
  values (p_id, 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'received', 'r/' || p_id || '.eml', p_received);
  perform public.record_parsed_message(p_id, '{"cleanText": "See the flyer", "language": "en", "referenceDate": "2026-11-17T00:00:00Z"}',
    jsonb_build_array(jsonb_build_object('filename', 'flyer.jpg', 'mime', 'image/jpeg', 'bytes', 1000, 'sha256', md5(p_id::text) || md5(p_id::text),
      'storage_path', 'aaaaaaaa-0000-4000-8000-000000000001/' || p_id || '/f')));
  perform public.record_triage(p_id, (select jsonb_agg(jsonb_build_object('id', a.id, 'status', p_status, 'pages', '[]'::jsonb,
    'triage', jsonb_build_object('stage', 4, 'reason', p_reason))) from public.attachments a where a.message_id = p_id));
  update public.attachments set triaged_at = p_triaged where message_id = p_id;
end $$;
create function pg_temp.queued(p_id uuid) returns integer language sql as $$
  select count(*)::int from pgmq.q_triage_message where message ->> 'message_id' = p_id::text $$;

select pg_temp.parked('d3100000-0000-4000-8000-000000000001', 'needs_vision_not_configured');
select pg_temp.parked('d3100000-0000-4000-8000-000000000002', 'daily_vision_limit', now() - interval '1 day');
select pg_temp.parked('d3100000-0000-4000-8000-000000000003', 'daily_vision_limit');
select pg_temp.parked('d3100000-0000-4000-8000-000000000004', 'owner_never');
select pg_temp.parked('d3100000-0000-4000-8000-000000000005', 'needs_vision_not_configured', now(), now() - interval '9 days');
select pg_temp.parked('d3100000-0000-4000-8000-000000000006', 'page_budget_used', now(), now(), 'skipped');
select pg_temp.parked('d3100000-0000-4000-8000-000000000007', 'no_schedule_found', now(), now(), 'skipped');
select pgmq.purge_queue('triage_message');

set local role authenticated;
select throws_ok($$ select public.requeue_parked_attachments() $$, '42501', null, 'only the service role sends parked files back');
reset role;

set local role service_role;
select ok(public.requeue_parked_attachments(50) >= 3, 'parked emails go back (at least the three made here)');
reset role;
select is(pg_temp.queued('d3100000-0000-4000-8000-000000000001'), 1, 'parked while image reading was off: queued');
select is(pg_temp.queued('d3100000-0000-4000-8000-000000000002'), 1, 'parked by yesterday''s page limit: queued');
select is(pg_temp.queued('d3100000-0000-4000-8000-000000000003'), 0, 'parked by today''s page limit: waits for tomorrow');
select is(pg_temp.queued('d3100000-0000-4000-8000-000000000004'), 0, 'a file the owner said never to use is left alone');
select is(pg_temp.queued('d3100000-0000-4000-8000-000000000005'), 0, 'an email older than 8 days is left alone (D77)');
select is(pg_temp.queued('d3100000-0000-4000-8000-000000000006'), 1, 'D74: a file skipped by the old five-page limit: queued');
select is(pg_temp.queued('d3100000-0000-4000-8000-000000000007'), 0, 'a file skipped for another reason is left alone');
select lives_ok($$ update public.messages set pages_for_ai = 37 where id = 'd3100000-0000-4000-8000-000000000001' $$, 'D74: an email can have more than five pages to read');

set local role service_role;
select is(public.requeue_parked_attachments(50), 0, 'an email already back in the queue is not queued twice');
reset role;

select * from finish();
rollback;
