-- State machines are enforced on UPDATE, explained on refusal, and exposed for code generation.
begin;
select * from no_plan();

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at) values
  ('f1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sm@example.test', '', now(), now());
insert into public.feeds (id, owner_id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'SM', 'sm-feed');
insert into public.messages (id, feed_id, subject, status) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 's', 'received');
insert into public.attachments (id, message_id, status) values
  ('f4000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'pending');
insert into public.events (id, feed_id, title, starts_at, status, published) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Concert', now() + interval '3 days', 'confirmed', true);
insert into public.reports (id, feed_id, kind) values
  ('f6000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'wrong_details');

-- Inserts may start in any valid state (nothing existing breaks).
select lives_ok($$ insert into public.messages (feed_id, status) values ('f2000000-0000-4000-8000-000000000001', 'extracted') $$,
  'a row may be inserted in any valid state');

-- Messages
select lives_ok($$ update public.messages set status = 'parsed' where id = 'f3000000-0000-4000-8000-000000000001' $$, 'received -> parsed is allowed');
select throws_ok($$ update public.messages set status = 'received' where id = 'f3000000-0000-4000-8000-000000000001' $$,
  '23514', 'message_status cannot move from "parsed" to "received". Allowed from "parsed": extracted, failed, ignored, needs_review.',
  'parsed -> received is refused, and the error lists the allowed moves');
select lives_ok($$ update public.messages set status = 'failed' where id = 'f3000000-0000-4000-8000-000000000001' $$, 'parsed -> failed');
select lives_ok($$ update public.messages set status = 'received' where id = 'f3000000-0000-4000-8000-000000000001' $$, 'failed -> received (retry)');
select lives_ok($$ update public.messages set subject = 'changed' where id = 'f3000000-0000-4000-8000-000000000001' $$, 'updates that don''t touch status are unaffected');

-- Attachments
select lives_ok($$ update public.attachments set status = 'skipped' where id = 'f4000000-0000-4000-8000-000000000001' $$, 'pending -> skipped');
select lives_ok($$ update public.attachments set status = 'pending' where id = 'f4000000-0000-4000-8000-000000000001' $$, 'skipped -> pending (owner says this one has the schedule)');
select lives_ok($$ update public.attachments set status = 'text_layer' where id = 'f4000000-0000-4000-8000-000000000001' $$, 'pending -> text_layer');
select throws_ok($$ update public.attachments set status = 'skipped' where id = 'f4000000-0000-4000-8000-000000000001' $$, '23514', null,
  'text_layer -> skipped is refused');

-- Events, and the SEQUENCE bump
select is((select sequence from public.events where id = 'f5000000-0000-4000-8000-000000000001'), 0, 'a new event starts at SEQUENCE 0');
update public.events set title = 'Winter concert' where id = 'f5000000-0000-4000-8000-000000000001';
select is((select sequence from public.events where id = 'f5000000-0000-4000-8000-000000000001'), 1, 'a visible change raises SEQUENCE');
update public.events set published = true where id = 'f5000000-0000-4000-8000-000000000001';
select is((select sequence from public.events where id = 'f5000000-0000-4000-8000-000000000001'), 1, 'a change subscribers can''t see doesn''t');
update public.events set starts_at = starts_at + interval '1 hour', sequence = 5 where id = 'f5000000-0000-4000-8000-000000000001';
select is((select sequence from public.events where id = 'f5000000-0000-4000-8000-000000000001'), 5, 'a caller that raised it itself is respected');
select lives_ok($$ update public.events set status = 'cancelled' where id = 'f5000000-0000-4000-8000-000000000001' $$, 'confirmed -> cancelled');
select is((select sequence from public.events where id = 'f5000000-0000-4000-8000-000000000001'), 6, 'cancelling raises SEQUENCE');
select lives_ok($$ update public.events set status = 'confirmed' where id = 'f5000000-0000-4000-8000-000000000001' $$, 'cancelled -> confirmed (restore)');

-- Reports
select lives_ok($$ update public.reports set status = 'dismissed' where id = 'f6000000-0000-4000-8000-000000000001' $$, 'open -> dismissed');
select throws_ok($$ update public.reports set status = 'resolved' where id = 'f6000000-0000-4000-8000-000000000001' $$, '23514', null,
  'dismissed -> resolved must reopen first');

-- Exposure for code generation and agents
set local role anon;
select is((select array_agg(k order by k) from jsonb_object_keys(public.state_machines()) k),
  array['attachment_status', 'event_status', 'message_status', 'report_status'], 'state_machines() lists every machine, to anyone');
select ok(public.state_machines()->'message_status'->'transitions' @> '[{"from":"parsed","to":"extracted"}]'::jsonb,
  'it includes the transitions');
reset role;

-- Every machine's states match the column's CHECK list exactly.
select is(
  (select array_agg(distinct s order by s) from (select from_state s from private.state_transitions where machine = 'message_status'
     union select to_state from private.state_transitions where machine = 'message_status') x),
  array['extracted', 'failed', 'ignored', 'needs_review', 'parsed', 'received'], 'message states match the CHECK constraint');
select is(
  (select array_agg(distinct s order by s) from (select from_state s from private.state_transitions where machine = 'attachment_status'
     union select to_state from private.state_transitions where machine = 'attachment_status') x),
  array['failed', 'pending', 'skipped', 'text_layer', 'transcribed'], 'attachment states match the CHECK constraint');

-- Account deletion reads one grace period
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is(public.account_status()->>'state', 'active', 'a new account is active');
select lives_ok($$ select public.request_account_deletion() $$, 'request deletion');
select is(public.account_status()->>'state', 'scheduled_for_deletion', 'then it is scheduled');
select is((public.account_status()->>'grace_days')::int, 14, 'the grace period is reported from the one definition');
select ok((public.account_status()->>'deletes_on')::timestamptz = (public.account_status()->>'deletion_requested_at')::timestamptz + interval '14 days',
  'deletes_on = requested + grace');
reset role;

select * from finish();
rollback;
