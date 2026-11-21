-- Phase 13: directory search, near-me, only public feeds, ranking, imported feeds.
begin;
select * from no_plan();

-- Fake ZIPs (999xx doesn't exist) around Land Park, Sacramento; 99904 is ~80 miles away.
insert into public.zip_codes (zip, location, city, state) values
  ('99901', 'SRID=4326;POINT(-121.500 38.550)', 'Testville', 'CA'),
  ('99902', 'SRID=4326;POINT(-121.520 38.560)', 'Testville', 'CA'),
  ('99903', 'SRID=4326;POINT(-121.300 38.700)', 'Farfield', 'CA'),
  ('99904', 'SRID=4326;POINT(-120.000 39.000)', 'Mountain', 'CA');
insert into public.feeds (owner_id, name, slug, description, category, zip_code, visibility) values
  ('11111111-1111-4111-8111-111111111111', 'Land Park Soccer Club', 'lp-soccer', 'Youth soccer games and practices in Land Park', 'youth sports', '99901', 'public'),
  ('11111111-1111-4111-8111-111111111111', 'Curtis Park Library Story Time', 'cp-library', 'Story time for toddlers', 'library', '99902', 'public'),
  ('11111111-1111-4111-8111-111111111111', 'Farfield Soccer League', 'ff-soccer', 'Soccer for all ages', 'youth sports', '99903', 'public'),
  ('11111111-1111-4111-8111-111111111111', 'Mountain Soccer', 'mtn-soccer', 'Soccer up the hill', 'youth sports', '99904', 'public'),
  ('11111111-1111-4111-8111-111111111111', 'Secret Soccer Parents', 'secret-soccer', 'Unlisted soccer group', 'youth sports', '99901', 'unlisted'),
  ('11111111-1111-4111-8111-111111111111', 'Private Soccer Notes', 'private-soccer', 'Private soccer', 'youth sports', '99901', 'private'),
  ('22222222-2222-4222-8222-222222222222', 'Old Land Park Soccer Archive', 'old-lp-soccer', 'Land Park soccer, old season', 'youth sports', '99901', 'public');
update public.feeds set last_updated_at = now() - interval '120 days' where slug = 'old-lp-soccer';
update public.feeds set last_updated_at = now() where slug in ('lp-soccer', 'cp-library', 'ff-soccer', 'mtn-soccer');

select ok((select location is not null from public.feeds where slug = 'lp-soccer'), 'a feed''s map point comes from its ZIP');
select is((select prosecdef from pg_proc where proname = 'directory_search'), false, 'search runs as the caller (SECURITY INVOKER), so RLS applies');

set local role anon;
select is((select array_agg(slug order by distance_miles) from public.directory_search(null, '99901', 5)), array['lp-soccer', 'old-lp-soccer', 'cp-library'],
  'near 99901 within 5 miles, nearest first (unlisted and private never appear)');
select is((select array_agg(slug) from public.directory_search(null, '99901', 25) where slug in ('ff-soccer', 'mtn-soccer')), array['ff-soccer'],
  '25 miles reaches the next town, not the mountain');
select is((select count(*)::int from public.directory_search('soccer') where slug in ('secret-soccer', 'private-soccer')), 0,
  'unlisted and private feeds never appear in search');
select is((select slug from public.directory_search('Land Park soccer', '99901', 10) limit 1), 'lp-soccer', '"Land Park soccer" puts the active Land Park club first');
select is((select may_be_out_of_date from public.directory_search('Land Park soccer', '99901', 10) where slug = 'old-lp-soccer'), true, 'a stale feed is labelled');
select ok((select score from public.directory_search('Land Park soccer') where slug = 'old-lp-soccer')
        < (select score from public.directory_search('Land Park soccer') where slug = 'lp-soccer'), '...and sinks below the active one');
select ok(exists (select 1 from public.directory_search('socer') where slug = 'lp-soccer'), 'a typo still finds the club (word similarity)');
select ok(exists (select 1 from public.directory_search('libary') where slug = 'cp-library'), 'and the library');
select is((select count(*)::int from public.directory_search('pizza')), 0, 'but an unrelated word finds nothing');
select is((select array_agg(slug) from public.directory_search(null, null, 10, 'library')), array['cp-library'], 'category filter');
select is((select count(*)::int from public.directory_search(null, '00000')), 0, 'an unknown ZIP returns nothing, not everything');
reset role;

update public.feeds set verified = true where slug = 'ff-soccer';
set local role anon;
select ok((select score from public.directory_search('soccer', '99901', 25) where slug = 'ff-soccer')
        > (select score from public.directory_search('soccer') where slug = 'ff-soccer') - 10, 'verified organizers are ranked (smoke)');
select throws_ok($$ select intake_address from public.feeds limit 1 $$, '42501', null, 'anon still cannot read intake addresses');
reset role;

-- ---------------------------------------------------------------- imported feeds
create temp table imp as select public.add_imported_feed('City Library Events', 'https://library.example.test/events.ics', 'City Library', 'library', '99902',
  '11111111-1111-4111-8111-111111111111') as id;
select is(public.record_import((select id from imp), '[
  {"uid": "a@lib", "title": "Story time", "starts_at": "2026-12-02T18:00:00Z", "timezone": "America/Los_Angeles"},
  {"uid": "b@lib", "title": "Book club", "starts_at": "2026-12-03T02:00:00Z", "timezone": "America/Los_Angeles"}]'), 2, 'the source''s events are imported');
select is(public.record_import((select id from imp), '[{"uid": "a@lib", "title": "Story time (moved)", "starts_at": "2026-12-02T19:00:00Z"}]'), 1, 'and re-imported daily');
select is((select title from public.events where feed_id = (select id from imp) and external_uid = 'a@lib'), 'Story time (moved)', 'changes are applied');
select is((select status from public.events where feed_id = (select id from imp) and external_uid = 'b@lib'), 'cancelled', 'events gone from the source are cancelled, not deleted');
set local role anon;
select is((select imported_source_name from public.directory_search('library') where slug like 'city-library-events%'), 'City Library', 'imported feeds are labelled with their source');
reset role;
select ok(exists (select 1 from cron.job where jobname = 'feedcal-import-feeds'), 'imports run daily');

select * from finish();
rollback;
