-- D44: a calendar's ZIP is suggested from addresses in its events and its approved senders' emails.
begin;
select * from no_plan();
create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
insert into public.zip_codes (zip, location, city, state) values
  ('95818', 'SRID=4326;POINT(-121.49 38.56)', 'Sacramento', 'CA'),
  ('95822', 'SRID=4326;POINT(-121.49 38.51)', 'Sacramento', 'CA')
  on conflict (zip) do nothing;
insert into public.feeds (id, owner_id, name, slug) values ('d2200000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Zip feed', 'zip-feed-x');

select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.feed_zip_suggestion('d2200000-0000-4000-8000-000000000001'), null, 'no addresses yet: no suggestion, nothing guessed');
reset role;

insert into public.events (feed_id, title, starts_at, timezone, location) values
  ('d2200000-0000-4000-8000-000000000001', 'Concert', now() + interval '3 days', 'America/Los_Angeles', 'Gym, 1234 Main St, Sacramento, CA 95818'),
  ('d2200000-0000-4000-8000-000000000001', 'Picnic', now() + interval '4 days', 'America/Los_Angeles', 'Land Park, Sacramento CA 95818-1234'),
  ('d2200000-0000-4000-8000-000000000001', 'Away game', now() + interval '5 days', 'America/Los_Angeles', 'Field 3, Sacramento, CA 95822'),
  ('d2200000-0000-4000-8000-000000000001', 'Fundraiser', now() + interval '6 days', 'America/Los_Angeles', 'Raise $12345 for Room 95818');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.feed_zip_suggestion('d2200000-0000-4000-8000-000000000001'), '{"zip": "95818", "places": 2}'::jsonb,
  'the ZIP in the most addresses wins (a bare number like "Room 95818" or "$12345" doesn''t count)');
reset role;

-- Emails from a sender the owner hasn't approved don't count.
insert into public.sources (id, feed_id, sender_email, trusted) values ('d2210000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-000000000001', 'stranger@example.test', false);
insert into public.messages (feed_id, source_id, status, clean_text) select 'd2200000-0000-4000-8000-000000000001', 'd2210000-0000-4000-8000-000000000001', 'extracted',
  'Visit us at 9 Elm St, Sacramento, CA 95822' from generate_series(1, 5);
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.feed_zip_suggestion('d2200000-0000-4000-8000-000000000001') ->> 'zip', '95818', 'an unapproved sender''s emails don''t move it');
reset role;

select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok($$ select public.feed_zip_suggestion('d2200000-0000-4000-8000-000000000001') $$, '42501', null, 'only the owner can ask');
reset role;

select * from finish();
rollback;
