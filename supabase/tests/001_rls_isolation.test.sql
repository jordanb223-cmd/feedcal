-- Phase 2 acceptance: RLS isolation, unlisted access via exact slug, token secrecy.
-- Self-contained fixtures (not the seed). Everything rolls back at the end.
begin;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures (as postgres)
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at) values
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.test', '', now(), now()),
  ('44444444-4444-4444-8444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger@example.test', '', now(), now());
insert into public.profiles (id, display_name) values
  ('33333333-3333-4333-8333-333333333333', 'Owner'),
  ('44444444-4444-4444-8444-444444444444', 'Stranger');

insert into public.feeds (id, owner_id, name, slug, visibility) values
  ('f0000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'Private feed', 'test-private', 'private'),
  ('f0000000-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333', 'Unlisted feed', 'secret-club', 'unlisted'),
  ('f0000000-0000-4000-8000-000000000003', '33333333-3333-4333-8333-333333333333', 'Public feed', 'test-public', 'public');

insert into public.sources (id, feed_id, sender_email) values
  ('50000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'sender@example.test');
insert into public.messages (id, feed_id, subject) values
  ('60000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'Private message');
insert into public.attachments (id, message_id, filename) values
  ('70000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'private.pdf');
insert into public.attachment_pages (attachment_id, page_index, text, text_source) values
  ('70000000-0000-4000-8000-000000000001', 0, 'private page text', 'transcription');
insert into public.events (id, feed_id, title, starts_at, published, evidence_quote) values
  ('e0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'Private event', now() + interval '1 day', true, 'q'),
  ('e0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000002', 'Unlisted event', now() + interval '1 day', true, 'q'),
  ('e0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000003', 'Public published', now() + interval '1 day', true, 'q'),
  ('e0000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000003', 'Public unpublished', now() + interval '2 days', false, 'q');

select set_config('test.unlisted_slug',
  (select slug from public.feeds where id = 'f0000000-0000-4000-8000-000000000002'), true);

-- ---------------------------------------------------------------- schema-wide guarantees
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0, 'RLS is enabled on every table in public');

select ok(current_setting('test.unlisted_slug') ~ '^secret-club-[a-z0-9]{8}$',
  'unlisted slug gets a random 8-character suffix');
select is((select count(*)::int from public.feed_editors
           where feed_id = 'f0000000-0000-4000-8000-000000000001' and role = 'owner'
             and user_id = '33333333-3333-4333-8333-333333333333'),
  1, 'creating a feed makes its owner an owner editor');
select is((select count(*)::int from vault.secrets s join public.feeds f on f.feed_token_secret_id = s.id
           where f.id = 'f0000000-0000-4000-8000-000000000001'),
  1, 'each feed has a Vault copy of its token');

-- ---------------------------------------------------------------- stranger (signed in, not a member)
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*)::int from public.feeds where id = 'f0000000-0000-4000-8000-000000000001'), 0, 'stranger cannot see private feed');
select is((select count(*)::int from public.feeds where id = 'f0000000-0000-4000-8000-000000000002'), 0, 'stranger cannot list unlisted feed from the table');
select is((select count(*)::int from public.events where feed_id = 'f0000000-0000-4000-8000-000000000001'), 0, 'stranger cannot see private events');
select is((select count(*)::int from public.messages), 0, 'stranger cannot see messages');
select is((select count(*)::int from public.attachments), 0, 'stranger cannot see attachments');
select is((select count(*)::int from public.attachment_pages), 0, 'stranger cannot see attachment pages');
select is((select count(*)::int from public.sources), 0, 'stranger cannot see sources');
select is((select count(*)::int from public.feed_editors where feed_id = 'f0000000-0000-4000-8000-000000000001'), 0, 'stranger cannot see editors');
select is((select count(*)::int from public.profiles where id = '33333333-3333-4333-8333-333333333333'), 0, 'stranger cannot read another profile');

update public.feeds set name = 'pwned' where id = 'f0000000-0000-4000-8000-000000000001';
update public.events set title = 'pwned' where id = 'e0000000-0000-4000-8000-000000000001';
delete from public.events where id = 'e0000000-0000-4000-8000-000000000001';
delete from public.messages where id = '60000000-0000-4000-8000-000000000001';

select throws_ok(
  $$ insert into public.events (feed_id, title, starts_at) values ('f0000000-0000-4000-8000-000000000001', 'x', now()) $$,
  '42501', null, 'stranger cannot add events to a private feed');
select throws_ok(
  $$ insert into public.feed_editors (feed_id, user_id, role) values ('f0000000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'editor') $$,
  '42501', null, 'stranger cannot make themselves an editor');
select throws_ok(
  $$ insert into public.feeds (owner_id, name, slug) values ('33333333-3333-4333-8333-333333333333', 'x', 'spoofed-owner') $$,
  '42501', null, 'nobody can set owner_id directly');
select throws_ok($$ select public.get_feed_token('f0000000-0000-4000-8000-000000000001') $$,
  '42501', null, 'stranger cannot read the feed token');
select throws_ok($$ select public.rotate_feed_token('f0000000-0000-4000-8000-000000000001') $$,
  '42501', null, 'stranger cannot rotate the feed token');
select lives_ok($$ insert into public.feeds (name, slug) values ('My own feed', 'stranger-own-feed') $$,
  'a signed-in user can create their own feed');

reset role;
select is((select name from public.feeds where id = 'f0000000-0000-4000-8000-000000000001'), 'Private feed', 'stranger update of feed changed nothing');
select is((select title from public.events where id = 'e0000000-0000-4000-8000-000000000001'), 'Private event', 'stranger update/delete of event changed nothing');
select is((select count(*)::int from public.messages where id = '60000000-0000-4000-8000-000000000001'), 1, 'stranger delete of message changed nothing');
select is((select owner_id from public.feeds where slug = 'stranger-own-feed'),
  '44444444-4444-4444-8444-444444444444'::uuid, 'owner_id defaults to the signed-in user');

-- ---------------------------------------------------------------- owner
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*)::int from public.events where feed_id = 'f0000000-0000-4000-8000-000000000001'), 1, 'owner sees their private events');
select is((select count(*)::int from public.messages), 1, 'owner sees their messages');
select is((select count(*)::int from public.attachment_pages), 1, 'owner sees their attachment pages');
select throws_ok($$ select feed_token_hash from public.feeds $$, '42501', null, 'even the owner cannot select the token hash column');
select set_config('test.token1', public.get_feed_token('f0000000-0000-4000-8000-000000000001'), true);
select ok(current_setting('test.token1') ~ '^[A-Za-z0-9_-]{43}$', 'owner reads back a 43-character URL-safe token');
select set_config('test.token2', public.rotate_feed_token('f0000000-0000-4000-8000-000000000001'), true);
select isnt(current_setting('test.token2'), current_setting('test.token1'), 'rotation makes a new token');
select is(public.get_feed_token('f0000000-0000-4000-8000-000000000001'), current_setting('test.token2'), 'read-back returns the rotated token');
select lives_ok(
  $$ insert into public.feed_editors (feed_id, user_id, role) values ('f0000000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'editor') $$,
  'owner can add an editor');

reset role;
select is((select feed_token_hash from public.feeds where id = 'f0000000-0000-4000-8000-000000000001'),
  private.token_hash(current_setting('test.token2')), 'stored hash is sha256 of the current token');
select isnt((select feed_token_hash from public.feeds where id = 'f0000000-0000-4000-8000-000000000001'),
  private.token_hash(current_setting('test.token1')), 'old token no longer matches after rotation');

-- ---------------------------------------------------------------- editor
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.events where feed_id = 'f0000000-0000-4000-8000-000000000001'), 1, 'editor sees the feed''s events');
select is(public.get_feed_token('f0000000-0000-4000-8000-000000000001'), current_setting('test.token2'), 'editor can read the token');
select throws_ok($$ select public.rotate_feed_token('f0000000-0000-4000-8000-000000000001') $$, '42501', null, 'editor cannot rotate the token');
delete from public.feeds where id = 'f0000000-0000-4000-8000-000000000001';
reset role;
select is((select count(*)::int from public.feeds where id = 'f0000000-0000-4000-8000-000000000001'), 1, 'editor cannot delete the feed');

-- ---------------------------------------------------------------- anon
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

select is((select count(*)::int from public.feeds where id = 'f0000000-0000-4000-8000-000000000003'), 1, 'anon sees a public feed');
select is((select count(*)::int from public.feeds where id = 'f0000000-0000-4000-8000-000000000002'), 0, 'anon cannot read an unlisted feed from the table');
select is((select count(*)::int from public.feeds where id = 'f0000000-0000-4000-8000-000000000001'), 0, 'anon cannot read a private feed');
select throws_ok($$ select feed_token_hash from public.feeds $$, '42501', null, 'anon cannot select the token hash');
select throws_ok($$ select intake_address from public.feeds $$, '42501', null, 'anon cannot select the intake address');
select is((select count(*)::int from public.events where feed_id = 'f0000000-0000-4000-8000-000000000003'), 1, 'anon sees only published events of a public feed');
select is((select count(*)::int from public.events where feed_id = 'f0000000-0000-4000-8000-000000000002'), 0, 'anon cannot read unlisted events from the table');
select throws_ok($$ select evidence_quote from public.events $$, '42501', null, 'anon cannot select evidence quotes');
select throws_ok($$ select count(*) from public.messages $$, '42501', null, 'anon has no access to messages');
select throws_ok($$ select count(*) from public.feed_fetch_daily $$, '42501', null, 'anon has no access to fetch stats');
select throws_ok($$ select count(*) from public.subscribe_clicks $$, '42501', null, 'anon has no access to click stats');
select throws_ok($$ select count(*) from public.supporters $$, '42501', null, 'anon has no access to supporters');
select throws_ok($$ select public.get_feed_token('f0000000-0000-4000-8000-000000000003') $$, '42501', null, 'anon cannot call get_feed_token');

select is((public.public_feed_page(current_setting('test.unlisted_slug'))->'feed'->>'name'), 'Unlisted feed',
  'anon reads an unlisted feed through public_feed_page with the exact slug');
select is(jsonb_array_length(public.public_feed_page(current_setting('test.unlisted_slug'))->'events'), 1,
  'public_feed_page returns the unlisted feed''s published events');
select is(public.public_feed_page('secret-club'), null, 'the slug without its suffix returns nothing');
select is(public.public_feed_page(upper(current_setting('test.unlisted_slug'))), null, 'slug match is exact (case-sensitive)');
select is(public.public_feed_page('test-private'), null, 'a private feed returns nothing');
select is(jsonb_array_length(public.public_feed_page('test-public')->'events'), 1, 'unpublished events are not returned');
select ok(not (public.public_feed_page('test-public')->'feed' ?| array['feed_token_hash', 'feed_token_secret_id', 'intake_address', 'owner_id']),
  'public_feed_page never returns token, intake address or owner id');
select ok(not (public.public_feed_page('test-public')->'events'->0 ?| array['evidence_quote', 'confidence', 'source_message_id']),
  'public_feed_page never returns evidence fields');

reset role;

-- ---------------------------------------------------------------- service-role-only tables
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$ select count(*) from public.feed_fetch_daily $$, '42501', null, 'signed-in users have no access to fetch stats');
select throws_ok($$ select count(*) from public.supporters $$, '42501', null, 'signed-in users have no access to supporters');
select throws_ok($$ select count(*) from public.jobs_dedupe $$, '42501', null, 'signed-in users have no access to jobs_dedupe');
-- Owner deletes a feed: its Vault secret goes too.
reset role;
select set_config('test.secret_id', (select feed_token_secret_id::text from public.feeds where id = 'f0000000-0000-4000-8000-000000000003'), true);
set local role authenticated;
delete from public.feeds where id = 'f0000000-0000-4000-8000-000000000003';
reset role;
select is((select count(*)::int from vault.secrets where id = current_setting('test.secret_id')::uuid), 0,
  'deleting a feed deletes its Vault secret');

select * from finish();
rollback;
