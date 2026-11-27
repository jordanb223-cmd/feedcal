-- D92: questions and chat messages go 30 days after their event is over; a question's scrambled
-- code is cleared after an hour.
begin;
select * from no_plan();

insert into public.feeds (id, owner_id, name, slug, visibility) values
  ('d3800000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Retention feed', 'retention-feed-x', 'unlisted');
insert into public.events (id, feed_id, title, starts_at, published, status, occurrences) values
  ('d3800000-0000-4000-8000-0000000000e1', 'd3800000-0000-4000-8000-000000000001', 'Long over', now() - interval '40 days', true, 'confirmed', '{}'),
  ('d3800000-0000-4000-8000-0000000000e2', 'd3800000-0000-4000-8000-000000000001', 'Over last week', now() - interval '7 days', true, 'confirmed', '{}'),
  ('d3800000-0000-4000-8000-0000000000e3', 'd3800000-0000-4000-8000-000000000001', 'Coming up', now() + interval '3 days', true, 'confirmed', '{}'),
  ('d3800000-0000-4000-8000-0000000000e4', 'd3800000-0000-4000-8000-000000000001', 'Repeats', now() - interval '60 days', true, 'confirmed',
   array[now() - interval '60 days', now() + interval '10 days']);

insert into public.event_questions (feed_id, event_id, body, asker_hash, created_at)
  select 'd3800000-0000-4000-8000-000000000001', e.id, 'Q on ' || e.title, extensions.digest('x', 'sha256'), now() - interval '2 hours'
  from public.events e where e.feed_id = 'd3800000-0000-4000-8000-000000000001';
insert into public.event_questions (feed_id, event_id, body, asker_hash)
  values ('d3800000-0000-4000-8000-000000000001', 'd3800000-0000-4000-8000-0000000000e3', 'Just asked', extensions.digest('y', 'sha256'));
insert into public.event_chat_messages (feed_id, event_id, body, author_hash, author_name)
  select 'd3800000-0000-4000-8000-000000000001', e.id, 'Chat on ' || e.title, extensions.digest('x', 'sha256'), 'Blue Otter'
  from public.events e where e.feed_id = 'd3800000-0000-4000-8000-000000000001';

create temp table r as select private.apply_retention() as j;

select is((select (j ->> 'questions_deleted')::int from r), 1, 'one question is deleted');
select is((select (j ->> 'chat_messages_deleted')::int from r), 1, 'and one chat message');
select is((select count(*)::int from public.event_questions where event_id = 'd3800000-0000-4000-8000-0000000000e1'), 0, 'the question on the event over 40 days ago is gone');
select is((select count(*)::int from public.event_chat_messages where event_id = 'd3800000-0000-4000-8000-0000000000e1'), 0, 'and its chat message');
select is((select count(*)::int from public.event_questions where event_id = 'd3800000-0000-4000-8000-0000000000e2'), 1, 'an event over a week ago keeps its question');
select is((select count(*)::int from public.event_chat_messages where event_id = 'd3800000-0000-4000-8000-0000000000e3'), 1, 'a coming event keeps its chat');
select is((select count(*)::int from public.event_questions where event_id = 'd3800000-0000-4000-8000-0000000000e4'), 1, 'a repeating event with a date still to come keeps its question');
select is((select count(*)::int from public.event_chat_messages where event_id = 'd3800000-0000-4000-8000-0000000000e4'), 1, 'and its chat');

select is((select count(*)::int from public.event_questions where feed_id = 'd3800000-0000-4000-8000-000000000001' and asker_hash is not null), 1, 'only the question just asked still has its scrambled code');
select is((select body from public.event_questions where feed_id = 'd3800000-0000-4000-8000-000000000001' and asker_hash is not null), 'Just asked', 'the one asked within the hour');
select ok((select bool_and(author_hash is not null) from public.event_chat_messages where feed_id = 'd3800000-0000-4000-8000-000000000001'), 'chat messages keep theirs, for the made-up name');

select * from finish();
rollback;
