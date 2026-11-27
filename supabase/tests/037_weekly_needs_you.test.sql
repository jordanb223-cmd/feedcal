-- D91: the weekly email's payload lists what is waiting, soonest first, and open questions.
begin;
select * from no_plan();

insert into public.feeds (id, owner_id, name, slug, visibility) values
  ('d3700000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Weekly feed', 'weekly-feed-x', 'unlisted');
insert into public.events (id, feed_id, title, starts_at, published, status) values
  ('d3700000-0000-4000-8000-0000000000e1', 'd3700000-0000-4000-8000-000000000001', 'On the calendar', now() + interval '2 days', true, 'confirmed'),
  ('d3700000-0000-4000-8000-0000000000e2', 'd3700000-0000-4000-8000-000000000001', 'A draft', now() + interval '5 days', false, 'tentative');
insert into public.event_questions (feed_id, event_id, body) values
  ('d3700000-0000-4000-8000-000000000001', 'd3700000-0000-4000-8000-0000000000e1', 'What time does it end?');
insert into public.event_questions (feed_id, event_id, body, status, answer, answered_at) values
  ('d3700000-0000-4000-8000-000000000001', 'd3700000-0000-4000-8000-0000000000e1', 'Answered already', 'answered', 'Yes', now());

create temp table t as
  select f.value as feed from jsonb_array_elements(private.digest_payload('11111111-1111-4111-8111-111111111111') -> 'feeds') f
  where f.value ->> 'id' = 'd3700000-0000-4000-8000-000000000001';

select is((select (feed ->> 'needs_review')::int from t), 1, 'the draft is counted as waiting');
select is((select jsonb_array_length(feed -> 'items') from t), 1, 'and listed');
select is((select feed #>> '{items,0,title}' from t), 'A draft', 'by its title');
select ok((select feed #> '{items,0}' ?& array['starts_at', 'all_day', 'timezone', 'reasons', 'outcome', 'change_kind'] from t), 'with when it is and why it waits');
select is((select (feed ->> 'open_questions')::int from t), 1, 'only the unanswered question is counted');
select is((select feed #>> '{questions,0,body}' from t), 'What time does it end?', 'and listed');
select is((select feed #>> '{questions,0,event_title}' from t), 'On the calendar', 'with the event it is about');

-- More than 8 waiting: the count is exact, the list stops at 8, soonest first.
insert into public.events (feed_id, title, starts_at, published, status)
  select 'd3700000-0000-4000-8000-000000000001', 'Extra ' || n, now() + (n || ' hours')::interval, false, 'tentative' from generate_series(1, 9) n;
create temp table t2 as
  select f.value as feed from jsonb_array_elements(private.digest_payload('11111111-1111-4111-8111-111111111111') -> 'feeds') f
  where f.value ->> 'id' = 'd3700000-0000-4000-8000-000000000001';
select is((select (feed ->> 'needs_review')::int from t2), 10, 'ten waiting are counted');
select is((select jsonb_array_length(feed -> 'items') from t2), 8, 'eight are listed');
select is((select feed #>> '{items,0,title}' from t2), 'Extra 1', 'soonest first');

-- Someone else's calendar is not in the payload.
select is((select count(*)::int from jsonb_array_elements(private.digest_payload('22222222-2222-4222-8222-222222222222') -> 'feeds') f
           where f.value ->> 'id' = 'd3700000-0000-4000-8000-000000000001'), 0, 'another person does not get this calendar''s items');

select * from finish();
rollback;
