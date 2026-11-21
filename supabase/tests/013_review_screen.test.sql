-- Phase 11: review actions, manual events, settings, 10-second undo, safe feed deletion.
begin;
select * from no_plan();

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.msg() returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin insert into public.messages (id, feed_id, status) values (v, 'aaaaaaaa-0000-4000-8000-000000000001', 'needs_review'); return v; end $$;

-- An existing published event and some review items, as the reconciler leaves them.
insert into public.events (id, feed_id, title, starts_at, timezone, status, published) values
  ('ab000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Walkathon', '2026-11-22 10:00 America/Los_Angeles', 'America/Los_Angeles', 'confirmed', true),
  ('ab000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'Draft: bake sale', '2026-11-21 09:00 America/Los_Angeles', 'America/Los_Angeles', 'tentative', false);
update public.events set confidence = 0.9 where id = 'ab000000-0000-4000-8000-000000000002';
create temp table m as select pg_temp.msg() as id;
insert into public.event_candidates (id, message_id, feed_id, title, starts_at, all_day, timezone, change_kind, confidence, evidence_quote, source_kind, state, outcome, event_id, review_reasons) values
  ('ac000000-0000-4000-8000-000000000001', (select id from m), 'aaaaaaaa-0000-4000-8000-000000000001', 'Walkathon', '2026-11-23 10:00 America/Los_Angeles', false, 'America/Los_Angeles', 'changed', 0.75, 'moves to Monday', 'body', 'needs_review', 'update', 'ab000000-0000-4000-8000-000000000001', '{low_confidence}'),
  ('ac000000-0000-4000-8000-000000000002', (select id from m), 'aaaaaaaa-0000-4000-8000-000000000001', 'Free iPads', '2026-11-22 10:00 America/Los_Angeles', false, 'America/Los_Angeles', 'new', 0.95, 'Saturday at 10 AM', 'body', 'needs_review', 'new', null, '{possible_injection}'),
  ('ac000000-0000-4000-8000-000000000003', (select id from m), 'aaaaaaaa-0000-4000-8000-000000000001', 'Spirit day', '2026-12-12 12:00 America/Los_Angeles', true, 'America/Los_Angeles', 'new', 0.9, 'Spirit day is Saturday, December 12', 'body', 'needs_review', 'new', null, '{}'),
  ('ac000000-0000-4000-8000-000000000004', (select id from m), 'aaaaaaaa-0000-4000-8000-000000000001', 'Walkathon', '2026-11-22 13:00 America/Los_Angeles', false, 'America/Los_Angeles', 'new', 0.9, 'Walkathon at 1 PM', 'body', 'needs_review', 'conflict', 'ab000000-0000-4000-8000-000000000001', '{}');
grant select on m to authenticated;

-- ---------------------------------------------------------------- a signed-in user can create a feed
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select lives_ok($$ insert into public.feeds (name, category, visibility, slug) values ('Bob new feed', 'school', 'unlisted', 'bob-new-feed') $$,
  'a signed-in user can create a feed (regression: Phase 6 trigger permissions)');
select matches((select intake_address from public.feeds where name = 'Bob new feed'), '^feed-[a-z2-7]{20}$', 'and it gets an intake address');
select matches((select slug from public.feeds where name = 'Bob new feed'), '^bob-new-feed-[a-z0-9]{8}$', 'an unlisted feed gets a random slug suffix');
reset role;
-- Members acting directly (not through RPCs) on things guarded by triggers:
insert into public.messages (id, feed_id, status, storage_path) values ('ae000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'received', 'x/y.eml');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select lives_ok($$ delete from public.messages where id = 'ae000000-0000-4000-8000-000000000001' $$, 'a member can delete a message (its file is queued for deletion)');
select lives_ok($$ update public.events set status = 'cancelled' where id = 'ab000000-0000-4000-8000-000000000001' $$, 'a member can change an event''s status directly');
reset role;
update public.events set status = 'confirmed' where id = 'ab000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------- strangers are refused everywhere
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok($$ select public.approve_candidate('ac000000-0000-4000-8000-000000000001') $$, 'P0002', null, 'a stranger cannot approve');
select throws_ok($$ select public.reject_candidate('ac000000-0000-4000-8000-000000000002', 'not_an_event') $$, 'P0002', null, 'or reject');
select throws_ok($$ select public.approve_all_sure('aaaaaaaa-0000-4000-8000-000000000001') $$, 'P0002', null, 'or approve all');
select throws_ok($$ select public.save_event('aaaaaaaa-0000-4000-8000-000000000001', null, '{"title": "x", "date": "2026-12-01", "all_day": true}') $$, 'P0002', null, 'or add events');
select throws_ok($$ select public.request_feed_deletion('aaaaaaaa-0000-4000-8000-000000000001') $$, '42501', null, 'or delete the feed');
reset role;

-- ---------------------------------------------------------------- the owner reviews
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.approve_candidate('ac000000-0000-4000-8000-000000000001', '{"date": "2026-11-23", "time": "11:00"}'),
  'ab000000-0000-4000-8000-000000000001'::uuid, 'approving an update with an edit applies it to the event');
select is((select starts_at from public.events where id = 'ab000000-0000-4000-8000-000000000001'), '2026-11-23 11:00 America/Los_Angeles'::timestamptz, 'the owner''s time wins');
select is((select actor from public.event_revisions where event_id = 'ab000000-0000-4000-8000-000000000001' order by id desc limit 1),
  'user:11111111-1111-4111-8111-111111111111', 'the revision names the owner');
select throws_ok($$ select public.approve_candidate('ac000000-0000-4000-8000-000000000001') $$, 'P0002', null, 'deciding twice is refused');

select is(public.approve_all_sure('aaaaaaaa-0000-4000-8000-000000000001'), 2, '"approve all Sure" takes the confident items and the confident draft');
select is((select state from public.event_candidates where id = 'ac000000-0000-4000-8000-000000000002'), 'needs_review', '...never a possible injection');
select is((select state from public.event_candidates where id = 'ac000000-0000-4000-8000-000000000004'), 'needs_review', '...nor a conflict');
select is((select published from public.events where title = 'Spirit day'), true, 'the approved new event is published');
select is((select published from public.events where id = 'ab000000-0000-4000-8000-000000000002'), true, 'the draft is published');

-- Reject with a reason, then undo within 10 seconds.
create temp table u as select public.reject_candidate('ac000000-0000-4000-8000-000000000002', 'not_an_event', 'spam') as id;
select is((select row(state, reject_reason)::text from public.event_candidates where id = 'ac000000-0000-4000-8000-000000000002'), row('rejected', 'not_an_event')::text,
  'rejecting keeps the reason for the evaluation set');
select is(public.undo((select id from u)), 'reject_candidate', 'undo within 10 seconds');
select is((select state from public.event_candidates where id = 'ac000000-0000-4000-8000-000000000002'), 'needs_review', 'the item is back in the queue');
select throws_ok(format('select public.undo(%L)', (select id from u)), 'P0002', null, 'an undo can''t be used twice');
reset role;
insert into public.undo_log (id, feed_id, user_id, kind, target, before, created_at)
values ('ad000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'reject_candidate', 'ac000000-0000-4000-8000-000000000002', '{}', now() - interval '11 seconds');
create temp table late as select 'ad000000-0000-4000-8000-000000000001'::uuid as id;
grant select on late, u to authenticated;
set local role authenticated;
select throws_ok(format('select public.undo(%L)', (select id from late)), 'P0001', 'Too late to undo.', 'after 10 seconds it''s too late');

-- ---------------------------------------------------------------- manual events
select throws_ok($$ select public.save_event('aaaaaaaa-0000-4000-8000-000000000001', null, '{"title": "Movie night", "date": "2026-12-05"}') $$,
  '22023', 'Please give a start time, or tick "All day".', 'a timed event needs a time (plain message)');
create temp table ne as select public.save_event('aaaaaaaa-0000-4000-8000-000000000001', null,
  '{"title": "Movie night", "date": "2026-12-05", "time": "18:30", "end_time": "20:30", "location": "Gym"}') as id;
select is((select row(starts_at, ends_at, published)::text from public.events where id = (select id from ne)),
  row('2026-12-05 18:30 America/Los_Angeles'::timestamptz, '2026-12-05 20:30 America/Los_Angeles'::timestamptz, true)::text, 'a manual event, in the feed''s timezone, published');
select lives_ok(format($$ select public.save_event('aaaaaaaa-0000-4000-8000-000000000001', %L, '{"title": "Movie night", "date": "2026-12-05", "time": "19:00", "location": "Gym"}') $$, (select id from ne)),
  'editing it');
select is((select count(*)::int from public.event_revisions where event_id = (select id from ne) and cause = 'manual_edit'), 2, 'history has the creation and the edit');
select is((select sequence from public.events where id = (select id from ne)), 1, 'the edit raises SEQUENCE');
create temp table cu as select public.cancel_event((select id from ne)) as id;
select is((select status from public.events where id = (select id from ne)), 'cancelled', 'cancelling an event');
select is(public.undo((select id from cu)), 'cancel_event', 'and undoing it');
select is((select status from public.events where id = (select id from ne)), 'confirmed', 'it is back');

-- ---------------------------------------------------------------- settings
select is(public.add_editor('aaaaaaaa-0000-4000-8000-000000000001', 'nobody@example.test'), 'not_found', 'an unknown email is reported, not an error');
select is(public.add_editor('aaaaaaaa-0000-4000-8000-000000000001', 'BOB@example.test'), 'added', 'adding an editor by email');
reset role;
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok($$ select public.add_editor('aaaaaaaa-0000-4000-8000-000000000001', 'x@example.test') $$, '42501', null, 'an editor cannot add editors');
select lives_ok($$ select public.approve_candidate('ac000000-0000-4000-8000-000000000004') $$, 'an editor can review');
reset role;

-- ---------------------------------------------------------------- deleting a feed, with undo
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select set_config('test.tok', public.get_feed_token('aaaaaaaa-0000-4000-8000-000000000002'), true);
reset role;
create temp table before_del as select slug, visibility from public.feeds where id = 'aaaaaaaa-0000-4000-8000-000000000002';
set local role authenticated;
create temp table del as select public.request_feed_deletion('aaaaaaaa-0000-4000-8000-000000000002') as id;
reset role;
select is(public.feed_calendar(current_setting('test.tok')), null, 'a feed being deleted stops serving its calendar at once');
select is(public.public_feed_page((select slug from before_del)), null, 'and its page');
grant select on del to authenticated;
set local role authenticated;
select is(public.undo((select id from del)), 'delete_feed', 'undo the deletion');
reset role;
select is((select row(slug, visibility)::text from public.feeds where id = 'aaaaaaaa-0000-4000-8000-000000000002'), (select row(slug, visibility)::text from before_del),
  'the same page address and visibility come back');
select isnt(public.feed_calendar(current_setting('test.tok')), null, 'and the same calendar link works again');

set local role authenticated;
select public.request_feed_deletion('aaaaaaaa-0000-4000-8000-000000000003');
reset role;
update public.feeds set delete_requested_at = now() - interval '11 seconds' where id = 'aaaaaaaa-0000-4000-8000-000000000003';
select is(private.purge_deleted_feeds(), 1, 'after 10 seconds the purge removes it');
select is((select count(*)::int from public.feeds where id = 'aaaaaaaa-0000-4000-8000-000000000003'), 0, 'gone');

select * from finish();
rollback;
