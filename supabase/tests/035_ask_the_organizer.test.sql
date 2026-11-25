-- D88: "Ask the organizer". A follower's anonymous question goes only to the calendar's people;
-- an answered one shows on the event's page; a private calendar gives no title away.
begin;
select * from no_plan();

insert into public.feeds (id, owner_id, name, slug, visibility) values
  ('d3500000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Question feed', 'question-feed-x', 'unlisted');
insert into public.events (id, feed_id, title, starts_at, published, status) values
  ('d3500000-0000-4000-8000-0000000000e1', 'd3500000-0000-4000-8000-000000000001', 'Field trip', now() + interval '3 days', true, 'confirmed'),
  ('d3500000-0000-4000-8000-0000000000e2', 'd3500000-0000-4000-8000-000000000001', 'Secret draft', now() + interval '4 days', false, 'tentative');
select set_config('test.uid', (select uid from public.events where id = 'd3500000-0000-4000-8000-0000000000e1'), true);
select set_config('test.draft', (select uid from public.events where id = 'd3500000-0000-4000-8000-0000000000e2'), true);
create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
delete from private.email_outbox where dedupe_key like 'question:%';

-- ---------------------------------------------------------------- asking
set local role anon;
select is(public.ask_question(current_setting('test.uid'), '  Should we bring a packed lunch?  '), 'ok', 'anyone with the event can ask');
select is(public.ask_question(current_setting('test.uid'), '   '), 'empty', 'an empty question is refused');
select is(public.ask_question(current_setting('test.draft'), 'Is this real?'), 'not_found', 'an event that isn''t on the calendar takes no questions');
select is(public.ask_question('nope@feedcal.app', 'Hello?'), 'not_found', 'nor does an unknown event');
select is(jsonb_array_length(public.event_questions_page(current_setting('test.uid')) -> 'answered'), 0, 'an unanswered question is not shown to anyone');
select throws_ok($$ select count(*) from public.event_questions $$, '42501', null, 'a stranger cannot read the questions table');
reset role;
select is((select body from public.event_questions where event_id = 'd3500000-0000-4000-8000-0000000000e1'), 'Should we bring a packed lunch?', 'stored trimmed');
select is((select count(*)::int from private.email_outbox where dedupe_key like 'question:%'), 1, 'the organizer is emailed');
select is((select payload ->> 'details' from private.email_outbox where dedupe_key like 'question:%'), 'Should we bring a packed lunch?', 'with the question');
select set_config('test.q', (select id::text from public.event_questions limit 1), true);

-- ---------------------------------------------------------------- who can see and answer
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select is((select count(*)::int from public.event_questions), 0, 'another organizer cannot see it');
select is(public.answer_question(current_setting('test.q')::uuid, 'Hijacked'), false, 'or answer it');
select is(public.hide_question(current_setting('test.q')::uuid), false, 'or hide it');
reset role;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is((select count(*)::int from public.event_questions), 1, 'the calendar''s owner sees it');
select throws_ok($$ select asker_hash from public.event_questions $$, '42501', null, 'but never who asked');
select is(public.answer_question(current_setting('test.q')::uuid, '   '), false, 'an empty answer is refused');
select is(public.answer_question(current_setting('test.q')::uuid, 'Yes, and a water bottle.'), true, 'the owner answers');
reset role;

-- ---------------------------------------------------------------- the public page
set local role anon;
select is(public.event_questions_page(current_setting('test.uid')) -> 'answered' -> 0 ->> 'question', 'Should we bring a packed lunch?', 'answered: the question shows');
select is(public.event_questions_page(current_setting('test.uid')) -> 'answered' -> 0 ->> 'answer', 'Yes, and a water bottle.', 'with the answer');
select is(public.event_questions_page(current_setting('test.uid')) -> 'event' ->> 'title', 'Field trip', 'an unlisted calendar''s event shows its title');
select is(public.event_questions_page(current_setting('test.draft')), null, 'a draft has no question page');
reset role;

-- Hiding takes it off the page.
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.hide_question(current_setting('test.q')::uuid), true, 'the owner hides it');
reset role;
set local role anon;
select is(jsonb_array_length(public.event_questions_page(current_setting('test.uid')) -> 'answered'), 0, 'hidden: off the page');
reset role;

-- A private calendar: questions work, the title and calendar name stay private.
update public.feeds set visibility = 'private' where id = 'd3500000-0000-4000-8000-000000000001';
set local role anon;
select is(public.event_questions_page(current_setting('test.uid')) -> 'event' -> 'title', 'null'::jsonb, 'private: no title');
select is(public.event_questions_page(current_setting('test.uid')) -> 'event' -> 'calendar', 'null'::jsonb, 'private: no calendar name');
select is(public.ask_question(current_setting('test.uid'), 'What time is pickup?'), 'ok', 'private: a follower can still ask');
reset role;

-- At most 30 waiting per event.
insert into public.event_questions (feed_id, event_id, body)
  select 'd3500000-0000-4000-8000-000000000001', 'd3500000-0000-4000-8000-0000000000e1', 'q' || g from generate_series(1, 29) g;
set local role anon;
select is(public.ask_question(current_setting('test.uid'), 'One too many?'), 'full', 'an event with 30 waiting takes no more');
reset role;

select * from finish();
rollback;
