-- D48: honest follower count; organizer calendar-link imports (one-time copy or daily).
begin;
select * from no_plan();
create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
insert into public.feeds (id, owner_id, name, slug) values ('d2300000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Count feed', 'count-feed-x');

-- ---------------------------------------------------------------- count
-- The same phone on 3 days (new code each day), 2 monitors, Google once: before this, 3+2+1 = 6.
insert into public.feed_fetch_daily (feed_id, day, client_hash, user_agent_family) values
  ('d2300000-0000-4000-8000-000000000001', current_date - 2, extensions.digest('a1', 'sha256'), 'apple'),
  ('d2300000-0000-4000-8000-000000000001', current_date - 1, extensions.digest('a2', 'sha256'), 'apple'),
  ('d2300000-0000-4000-8000-000000000001', current_date,     extensions.digest('a3', 'sha256'), 'apple'),
  ('d2300000-0000-4000-8000-000000000001', current_date - 1, extensions.digest('m1', 'sha256'), 'other'),
  ('d2300000-0000-4000-8000-000000000001', current_date - 1, extensions.digest('m2', 'sha256'), 'other'),
  ('d2300000-0000-4000-8000-000000000001', current_date - 1, extensions.digest('g1', 'sha256'), 'google');
select is(private.subscriber_estimate('d2300000-0000-4000-8000-000000000001', current_date - 7, current_date), 2,
  'busiest single day, calendar apps only: 1 Apple + Google = 2 (not 6)');
insert into public.feed_fetch_daily (feed_id, day, client_hash, user_agent_family) values
  ('d2300000-0000-4000-8000-000000000001', current_date, extensions.digest('a4', 'sha256'), 'apple'),
  ('d2300000-0000-4000-8000-000000000001', current_date, extensions.digest('a5', 'sha256'), 'apple');
select is(private.subscriber_estimate('d2300000-0000-4000-8000-000000000001', current_date - 7, current_date), 3,
  'three different Apple clients on one day count as 3');

-- ---------------------------------------------------------------- imports
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok($$ select public.feed_import_set('d2300000-0000-4000-8000-000000000001', 'https://cal.example.org/a.ics') $$, '42501', null, 'only the owner can import');
reset role;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.feed_import_set('d2300000-0000-4000-8000-000000000001', 'http://cal.example.org/a.ics'), 'bad_url', 'https only');
select is(public.feed_import_set('d2300000-0000-4000-8000-000000000001', 'https://10.0.0.1/a.ics'), 'bad_url', 'no bare IP numbers');
select is(public.feed_import_set('d2300000-0000-4000-8000-000000000001', 'webcal://cal.example.org/a.ics'), 'ok', 'a webcal link is accepted');
select is(public.feed_import_status('d2300000-0000-4000-8000-000000000001') ->> 'url', 'https://cal.example.org/a.ics', '...and stored as https');
select is(public.feed_import_status('d2300000-0000-4000-8000-000000000001') ->> 'mode', 'once', 'one-time copy unless asked');
reset role;

-- A one-time copy: events stay, the link is forgotten, nothing else on the calendar is touched.
insert into public.events (feed_id, title, starts_at, timezone, published) values ('d2300000-0000-4000-8000-000000000001', 'From email', now() + interval '2 days', 'America/Los_Angeles', true);
set local role service_role;
select is(public.record_import('d2300000-0000-4000-8000-000000000001',
  '[{"uid":"x1@src","title":"Imported game","starts_at":"2026-12-05T18:00:00Z","timezone":"America/Los_Angeles"}]'), 1, 'imported 1 event');
reset role;
select is((select import_url from public.feeds where id = 'd2300000-0000-4000-8000-000000000001'), null, 'one-time copy: the link is forgotten');
select is((select count(*)::int from public.events where feed_id = 'd2300000-0000-4000-8000-000000000001' and status <> 'cancelled'), 2,
  'the imported event and the email event are both on the calendar');

-- Daily: the link stays.
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.feed_import_set('d2300000-0000-4000-8000-000000000001', 'https://cal.example.org/b.ics', true), 'ok', 'keep checking daily');
reset role;
set local role service_role;
select public.record_import('d2300000-0000-4000-8000-000000000001', '[]');
reset role;
select is((select import_url from public.feeds where id = 'd2300000-0000-4000-8000-000000000001'), 'https://cal.example.org/b.ics', 'daily: the link stays');
select is((select status from public.events where feed_id = 'd2300000-0000-4000-8000-000000000001' and title = 'From email'), 'confirmed',
  'an import never cancels events that came from email or by hand');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.feed_import_stop('d2300000-0000-4000-8000-000000000001'), true, 'the owner can stop it');
reset role;
select is((select count(*)::int from cron.job where jobname = 'feedcal-import-feeds' and schedule = '*/10 * * * *'), 1, 'imports checked every 10 minutes');

select * from finish();
rollback;
