-- D89: a chat on one event, switched on by the organizer. Anonymous, text only, limited,
-- moderated, and closed when the event is over.
begin;
select * from no_plan();

insert into public.feeds (id, owner_id, name, slug, visibility) values
  ('d3600000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Chat feed', 'chat-feed-x', 'unlisted');
insert into public.events (id, feed_id, title, starts_at, published, status) values
  ('d3600000-0000-4000-8000-0000000000e1', 'd3600000-0000-4000-8000-000000000001', 'Movie night', now() + interval '3 days', true, 'confirmed'),
  ('d3600000-0000-4000-8000-0000000000e2', 'd3600000-0000-4000-8000-000000000001', 'Last week''s fair', now() - interval '7 days', true, 'confirmed');
select set_config('test.uid', (select uid from public.events where id = 'd3600000-0000-4000-8000-0000000000e1'), true);
select set_config('test.old', (select uid from public.events where id = 'd3600000-0000-4000-8000-0000000000e2'), true);
create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.shown() returns integer language sql as $$
  select jsonb_array_length(public.chat_page(current_setting('test.uid')) -> 'messages') $$;

-- ---------------------------------------------------------------- off until the organizer switches it on
set local role anon;
select is(public.chat_page(current_setting('test.uid')), null, 'no chat page until the organizer switches it on');
select is(public.chat_post(current_setting('test.uid'), 'Hello?'), 'closed', 'and nobody can post');
reset role;
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select is(public.set_event_chat('d3600000-0000-4000-8000-0000000000e1', true), false, 'another organizer cannot switch it on');
reset role;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.set_event_chat('d3600000-0000-4000-8000-0000000000e1', true), true, 'the owner switches it on');
select is(public.set_event_chat('d3600000-0000-4000-8000-0000000000e2', true), true, 'and on a past event too');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------- posting
set local role anon;
select is(public.chat_page(current_setting('test.uid')) ->> 'open', 'true', 'open');
select is(public.chat_post(current_setting('test.uid'), '  Is   there
 parking? '), 'ok', 'a follower posts');
select is(public.chat_page(current_setting('test.uid')) -> 'messages' -> 0 ->> 'body', 'Is there parking?', 'stored on one line, trimmed');
select ok((public.chat_page(current_setting('test.uid')) -> 'messages' -> 0 ->> 'name') ~ '^[A-Z][a-z]+ [A-Z][a-z]+$', 'under a made-up name');
select is(public.chat_page(current_setting('test.uid')) -> 'messages' -> 0 ->> 'organizer', 'false', 'not marked as the organizer');
select is(public.chat_post(current_setting('test.uid'), 'Another one'), 'slow_down', 'one message every 10 seconds');
select is(public.chat_post(current_setting('test.uid'), '   '), 'empty', 'empty is refused');
select is(public.chat_post(current_setting('test.old'), 'Was it fun?'), 'closed', 'an event that is over is closed');
select is(public.chat_page(current_setting('test.old')) ->> 'open', 'false', 'and its page says so');
select throws_ok($$ select count(*) from public.event_chat_messages $$, '42501', null, 'the messages table is not readable directly');
reset role;
update public.event_chat_messages set created_at = now() - interval '1 minute';
set local role anon;
select is(public.chat_post(current_setting('test.uid'), 'See https://example.test/x'), 'no_links', 'no links');
select is(public.chat_post(current_setting('test.uid'), 'go to WWW.example.test'), 'no_links', 'in any form');
select is(public.chat_post(current_setting('test.uid'), 'visit cheap-stuff.com now'), 'no_links', 'or a bare site name');
select is(public.chat_post(current_setting('test.uid'), 'Doors at 6.30, right?'), 'ok', 'ordinary punctuation is fine');
reset role;
select is((select count(distinct author_name)::int from public.event_chat_messages where event_id = 'd3600000-0000-4000-8000-0000000000e1'), 1, 'the same person keeps the same name on an event');

-- The organizer posts as the organizer, with no waiting.
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.chat_post(current_setting('test.uid'), 'Yes, parking is behind the gym.'), 'ok', 'the owner replies');
select is(public.chat_post(current_setting('test.uid'), 'Gates open at 5.'), 'ok', 'without the 10-second wait');
select is(public.chat_page(current_setting('test.uid')) -> 'messages' -> 2 ->> 'name', 'Organizer', 'named Organizer');
select is(public.chat_page(current_setting('test.uid')) ->> 'moderator', 'true', 'and sees moderator controls');
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
select is(public.chat_page(current_setting('test.uid')) ->> 'moderator', 'false', 'a follower does not');
reset role;

-- ---------------------------------------------------------------- reports and removal
select set_config('test.m', (select id::text from public.event_chat_messages where body = 'Is there parking?'), true);
select set_config('test.org', (select id::text from public.event_chat_messages where body = 'Gates open at 5.'), true);
select is(private.chat_report_inner(current_setting('test.m')::uuid, '198.51.100.1'), true, 'a reader reports a message');
select is(private.chat_report_inner(current_setting('test.m')::uuid, '198.51.100.1'), true, 'the same reader again');
select is(private.chat_report_inner(current_setting('test.m')::uuid, '198.51.100.2'), true, 'a second reader');
select is(pg_temp.shown(), 4, 'two reporters: still showing');
select is(private.chat_report_inner(current_setting('test.m')::uuid, '198.51.100.3'), true, 'a third reader');
select is(pg_temp.shown(), 3, 'three reporters: hidden');
select is(private.chat_report_inner(current_setting('test.org')::uuid, '198.51.100.1'), false, 'the organizer''s own messages cannot be reported away');

select set_config('test.m2', (select id::text from public.event_chat_messages where body = 'Doors at 6.30, right?'), true);
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select is(public.chat_remove(current_setting('test.m2')::uuid), false, 'another organizer cannot remove a message');
reset role;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.chat_remove(current_setting('test.m2')::uuid), true, 'the owner removes one');
select is(pg_temp.shown(), 2, 'and it is gone from the page');

-- ---------------------------------------------------------------- switched off, and the calendar file
select set_config('test.token', public.get_feed_token('d3600000-0000-4000-8000-000000000001'), true);
reset role;
select ok((select (ev ->> 'chat')::boolean from jsonb_array_elements(public.feed_calendar(current_setting('test.token')) -> 'events') ev where ev ->> 'title' = 'Movie night'),
  'the calendar file knows this event has a chat');
select is((select (ev ->> 'chat')::boolean from jsonb_array_elements(public.feed_calendar(current_setting('test.token')) -> 'events') ev where ev ->> 'title' = 'Last week''s fair'), false,
  'an event that is over has no open chat to link to');
set local role authenticated;
select is(public.set_event_chat('d3600000-0000-4000-8000-0000000000e1', false), true, 'the owner switches it off');
select is(pg_temp.shown(), 0, 'off: no messages are shown');
select is(public.chat_page(current_setting('test.uid')) ->> 'open', 'false', 'off: closed');
select is(public.chat_post(current_setting('test.uid'), 'Still there?'), 'closed', 'off: nobody can post, not even the owner');
reset role;

-- A private calendar: no title or calendar name on the chat page.
update public.feeds set visibility = 'private' where id = 'd3600000-0000-4000-8000-000000000001';
set local role anon;
select is(public.chat_page(current_setting('test.uid')) -> 'event' -> 'title', 'null'::jsonb, 'private: no title');
select is(public.chat_page(current_setting('test.uid')) -> 'event' -> 'calendar', 'null'::jsonb, 'private: no calendar name');
reset role;

select * from finish();
rollback;
