-- D77: the owner is told at once when events publish on their own; old mail is not retried.
begin;
select * from no_plan();
select pgmq.purge_queue('reconcile_message');
select pgmq.purge_queue('extract_message');
select pgmq.purge_queue('triage_message');
delete from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001';
delete from public.notification_settings;
delete from private.email_outbox;

insert into public.messages (id, feed_id, source_id, status, original_subject, clean_text) values
  ('d3300000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'parsed', 'TGIF', 'x');
create function pg_temp.cand(p_title text, p_conf numeric) returns jsonb language sql as $$
  select jsonb_build_object('title', p_title, 'starts_at', now() + interval '10 days', 'ends_at', null, 'all_day', true, 'timezone', 'America/Los_Angeles',
    'location', null, 'description', null, 'recurrence', null, 'status', 'new', 'confidence', p_conf, 'evidence_quote', 'quoted ' || p_title,
    'source_ref', jsonb_build_object('kind', 'body', 'attachment_id', null, 'page_index', null), 'review', '[]'::jsonb, 'from_transcription', false) $$;
create function pg_temp.read(p_id uuid, variadic p_cands jsonb[]) returns void language plpgsql as $$
begin
  perform public.record_extraction(p_id, jsonb_build_object('state', 'extracted', 'reason', null, 'model', 'm', 'calls', '[]'::jsonb, 'rejected', '[]'::jsonb, 'candidates', to_jsonb(p_cands)));
  perform public.reconcile_pending(100);
end $$;
create function pg_temp.mail() returns setof private.email_outbox language sql as $$
  select * from private.email_outbox where kind = 'events_published' order by created_at $$;

-- One published, one held as a draft: the owner hears about the published one only.
select pg_temp.read('d3300000-0000-4000-8000-000000000001', pg_temp.cand('Book fair', 0.95), pg_temp.cand('Maybe a party', 0.55));
select is((select count(*)::int from pg_temp.mail()), 1, 'one email for the email that was read');
select is((select user_id from pg_temp.mail()), '11111111-1111-4111-8111-111111111111'::uuid, 'to the calendar''s owner');
select is((select jsonb_agg(i ->> 'title') from pg_temp.mail() o, jsonb_array_elements(o.payload -> 'items') i), '["Book fair"]'::jsonb,
  'it lists what was published, not what is waiting');
select is((select o.payload -> 'items' -> 0 ->> 'quote' from pg_temp.mail() o), 'quoted Book fair', 'with the words it was read from');
select is((select o.payload ->> 'subject' from pg_temp.mail() o), 'TGIF', 'and which email');

-- Nothing published: no email.
insert into public.messages (id, feed_id, source_id, status, original_subject, clean_text) values
  ('d3300000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'parsed', 'Quiet week', 'x');
select pg_temp.read('d3300000-0000-4000-8000-000000000002', pg_temp.cand('Unsure thing', 0.55));
select is((select count(*)::int from pg_temp.mail()), 1, 'an email that published nothing sends nothing');

-- The owner can switch it off, from the link or the account page.
select is(public.unsubscribe('11111111-1111-4111-8111-111111111111', 'events_published', private.unsubscribe_token('11111111-1111-4111-8111-111111111111', 'events_published')), true,
  'the link in the email works');
select is((select published_events from public.notification_settings where user_id = '11111111-1111-4111-8111-111111111111'), false, 'it switches off this kind');
select is((select weekly_digest from public.notification_settings where user_id = '11111111-1111-4111-8111-111111111111'), true, 'and no other');
insert into public.messages (id, feed_id, source_id, status, original_subject, clean_text) values
  ('d3300000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'parsed', 'Next week', 'x');
select pg_temp.read('d3300000-0000-4000-8000-000000000003', pg_temp.cand('Science night', 0.95));
select is((select count(*)::int from pg_temp.mail()), 1, 'switched off: no more of these emails');
select is((select published from public.events where title = 'Science night'), true, 'the event still publishes');

-- ---------------------------------------------------------------- 8-day retry windows
insert into public.messages (id, feed_id, status, clean_text, received_at) values
  ('d3300000-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000001', 'parsed', 'x', now() - interval '2 days'),
  ('d3300000-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-000000000001', 'parsed', 'x', now() - interval '9 days');
select public.record_extraction_waiting('d3300000-0000-4000-8000-000000000011', 'daily_ai_limit');
select public.record_extraction_waiting('d3300000-0000-4000-8000-000000000012', 'daily_ai_limit');
select pgmq.purge_queue('extract_message');
select public.requeue_waiting_extractions(1000);
select is((select count(*)::int from pgmq.q_extract_message where message ->> 'message_id' = 'd3300000-0000-4000-8000-000000000011'), 1, 'a waiting email from 2 days ago is retried');
select is((select count(*)::int from pgmq.q_extract_message where message ->> 'message_id' = 'd3300000-0000-4000-8000-000000000012'), 0, 'one from 9 days ago is not');

-- ---------------------------------------------------------------- D78: daily picture pages
select is((private.triage_limits() ->> 'vision_pages_per_day')::int, 100, 'an owner can have 100 picture pages read a day (was 20)');

select * from finish();
rollback;
