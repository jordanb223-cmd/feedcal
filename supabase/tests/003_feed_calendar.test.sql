-- Phase 4: feed_calendar() serves a feed only for the exact token, and counts fetches privately.
begin;
select * from no_plan();

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at) values
  ('c1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cal-owner@example.test', '', now(), now());
insert into public.feeds (id, owner_id, name, slug, visibility) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'Private cal', 'cal-private', 'private');
insert into public.sources (id, feed_id, sender_email, sender_domain) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'office@school.example.test', 'school.example.test');
insert into public.messages (id, feed_id, source_id, subject) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 's');
insert into public.events (id, feed_id, title, starts_at, published, status, source_message_id, evidence_quote) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Published', now() + interval '1 day', true, 'confirmed', 'c4000000-0000-4000-8000-000000000001', 'secret quote'),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Draft', now() + interval '2 days', false, 'tentative', null, null),
  ('c5000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'Recently cancelled', now() + interval '3 days', true, 'cancelled', null, null),
  ('c5000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001', 'Long cancelled', now() + interval '4 days', true, 'cancelled', null, null);
-- Backdate the long-cancelled event's last change past 30 days (the trigger sets updated_at on update).
alter table public.events disable trigger events_before_write;
update public.events set updated_at = now() - interval '31 days' where id = 'c5000000-0000-4000-8000-000000000004';
alter table public.events enable trigger events_before_write;

-- Read the token as the owner, the only way to get it.
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.token', public.get_feed_token('c2000000-0000-4000-8000-000000000001'), true);
reset role;

set local role anon;
select is(public.feed_calendar(current_setting('test.token'))->'feed'->>'name', 'Private cal',
  'anon gets a private feed with its exact token');
select is(public.feed_calendar('x' || substr(current_setting('test.token'), 2)), null, 'a wrong token returns nothing');
select is(public.feed_calendar('short'), null, 'a malformed token returns nothing');
select is(public.feed_calendar(null), null, 'no token returns nothing');
select is(
  (select array_agg(e->>'title' order by e->>'title') from jsonb_array_elements(public.feed_calendar(current_setting('test.token'))->'events') e),
  array['Published', 'Recently cancelled'],
  'published events plus cancellations from the last 30 days; no drafts, no old cancellations');
select ok(not (public.feed_calendar(current_setting('test.token'))->'events'->0 ?| array['evidence_quote', 'confidence', 'source_message_id']),
  'evidence fields are never returned');
select is(public.feed_calendar(current_setting('test.token'))->'events'->0->>'source', 'school.example.test',
  'the source line is the sender''s domain, not the address');
select ok(not (public.feed_calendar(current_setting('test.token'))->'feed' ?| array['feed_token_hash', 'intake_address', 'owner_id']),
  'feed secrets are never returned');
select throws_ok($$ select count(*) from public.feed_fetch_daily $$, '42501', null, 'anon still cannot read fetch stats');

-- Fetch counting: the same client twice in a day is one row; a different client is another.
select lives_ok($$ select public.feed_calendar(current_setting('test.token'), '203.0.113.7', 'Google-Calendar-Importer', 'google') $$, 'a fetch with client info succeeds');
select lives_ok($$ select public.feed_calendar(current_setting('test.token'), '203.0.113.7', 'Google-Calendar-Importer', 'google') $$, 'the same client again succeeds');
select lives_ok($$ select public.feed_calendar(current_setting('test.token'), '198.51.100.9', 'iOS/18 dataaccessd', 'apple') $$, 'a second client succeeds');
reset role;

select is((select count(*)::int from public.feed_fetch_daily where feed_id = 'c2000000-0000-4000-8000-000000000001'), 2,
  'two distinct clients today make two rows');
select is((select count(*)::int from public.feed_fetch_daily f
           where f.feed_id = 'c2000000-0000-4000-8000-000000000001'
             and (encode(f.client_hash, 'escape') like '%203.0.113.7%' or encode(f.client_hash, 'hex') like '%' || encode(convert_to('203.0.113.7', 'UTF8'), 'hex') || '%')),
  0, 'the raw IP is not stored');
select is((select array_agg(user_agent_family order by user_agent_family) from public.feed_fetch_daily where feed_id = 'c2000000-0000-4000-8000-000000000001'),
  array['apple', 'google'], 'only the user-agent family is kept');

-- Rotation: the old token stops working at once.
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.token2', public.rotate_feed_token('c2000000-0000-4000-8000-000000000001'), true);
reset role;
set local role anon;
select is(public.feed_calendar(current_setting('test.token')), null, 'after rotation the old link returns nothing');
select isnt(public.feed_calendar(current_setting('test.token2')), null, 'the new link works');
reset role;

select * from finish();
rollback;
