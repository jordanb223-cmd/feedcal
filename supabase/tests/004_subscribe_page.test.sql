-- Phase 5: the subscribe page returns the link only for public/unlisted feeds; clicks are counted privately.
begin;
select * from no_plan();

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at) values
  ('d1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sub-owner@example.test', '', now(), now()),
  ('d1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sub-other@example.test', '', now(), now());
insert into public.feeds (id, owner_id, name, slug, visibility) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Public', 'sub-public', 'public'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'Unlisted', 'sub-unlisted', 'unlisted'),
  ('d2000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001', 'Private', 'sub-private', 'private');
select set_config('test.unlisted', (select slug from public.feeds where id = 'd2000000-0000-4000-8000-000000000002'), true);

select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.public_token', public.get_feed_token('d2000000-0000-4000-8000-000000000001'), true);
reset role;

set local role anon;
select is(public.public_feed_page('sub-public')->'feed'->>'feed_token', current_setting('test.public_token'),
  'a public page carries its subscription token');
select ok(public.public_feed_page(current_setting('test.unlisted'))->'feed'->>'feed_token' ~ '^[A-Za-z0-9_-]{43}$',
  'an unlisted page (exact slug) carries its token');
select is(public.public_feed_page('sub-private'), null, 'a private feed still has no page and no token');
select is(public.feed_calendar(public.public_feed_page('sub-public')->'feed'->>'feed_token')->'feed'->>'name', 'Public',
  'the token on the page opens the feed');

select is(public.record_subscribe_click('sub-public', 'apple'), true, 'a click on a public page counts');
select is(public.record_subscribe_click('sub-public', 'apple'), true, 'a second click counts');
select is(public.record_subscribe_click('sub-public', 'google'), true, 'another platform counts');
select is(public.record_subscribe_click('sub-private', 'apple'), false, 'a private feed''s clicks never count');
select is(public.record_subscribe_click('sub-public', 'evil'), false, 'an unknown platform is ignored');
select is(public.record_subscribe_click('no-such-feed', 'apple'), false, 'an unknown slug is ignored');
select throws_ok($$ select count(*) from public.subscribe_clicks $$, '42501', null, 'anon cannot read click stats');
select throws_ok($$ select public.feed_subscribe_stats('d2000000-0000-4000-8000-000000000001') $$, '42501', null, 'anon cannot call the stats function');
reset role;

select is((select count from public.subscribe_clicks where feed_id = 'd2000000-0000-4000-8000-000000000001' and platform = 'apple'), 2,
  'clicks accumulate per platform per day');

select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is(public.feed_subscribe_stats('d2000000-0000-4000-8000-000000000001')->'clicks_30d', '{"apple": 2, "google": 1}'::jsonb,
  'the owner sees click totals by platform');
reset role;
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is(public.feed_subscribe_stats('d2000000-0000-4000-8000-000000000001'), null, 'a stranger sees nothing');
reset role;

select * from finish();
rollback;
