-- Phase 16: keys in Vault (a dump alone reveals no token or key), rate limits, the feed-miss
-- guard, the data export, full deletion and the daily purge schedule.
begin;
select * from no_plan();
delete from private.rate_hits;  -- start clean (rolled back)

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at) values
  ('d1600000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'hardening@example.test', '', now(), now());
insert into public.feeds (id, owner_id, name, slug, visibility) values
  ('d1610000-0000-4000-8000-000000000001', 'd1600000-0000-4000-8000-000000000001', 'Hardening cal', 'hardening-cal', 'private');
insert into public.events (feed_id, title, starts_at, published) values
  ('d1610000-0000-4000-8000-000000000001', 'Practice', now() + interval '1 day', true);
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.token', public.get_feed_token('d1610000-0000-4000-8000-000000000001'), true);
reset role;

-- ---------------------------------------------------------------- a dump alone reveals nothing
select is((select relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relname = 'notification_key'), 'v',
  'the unsubscribe key is no longer a table: it is read from Vault');
select is((select relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relname = 'login_salt'), 'v',
  'the sign-in salt too');
select is((select octet_length(key) from private.notification_key), 32, 'the key is still there, 32 bytes');
select is((select octet_length(salt) from private.login_salt), 32, 'the salt is still there, 32 bytes');
select is((select count(*)::int from vault.secrets s where s.secret like '%' || current_setting('test.token') || '%'), 0,
  'Vault''s stored (encrypted) column does not contain the feed token');
select is((select count(*)::int from vault.secrets s where s.name = 'feedcal_notification_key'
  and s.secret like '%' || (select encode(key, 'hex') from private.notification_key) || '%'), 0, 'nor the unsubscribe key');
select is((select count(*)::int from public.feeds f where position(convert_to(current_setting('test.token'), 'UTF8') in f.feed_token_hash) > 0), 0,
  'the feeds table holds only the token''s hash');
set local role anon;
select throws_ok($$ select * from private.notification_key $$, '42501', null, 'anon cannot read the key');
reset role;
set local role authenticated;
select throws_ok($$ select * from private.login_salt $$, '42501', null, 'nor can a signed-in user read the salt');
reset role;

-- ---------------------------------------------------------------- the feed-miss guard
set local role anon;
select is(public.feed_calendar_guarded(current_setting('test.token'), '198.51.100.7') -> 'feed' ->> 'name', 'Hardening cal', 'a real token works');
select is(public.feed_calendar_guarded('x' || repeat('A', 42), '198.51.100.7'), null, 'a wrong token is a plain miss');
reset role;
select is((select count(*)::int from private.rate_hits where bucket = 'feed_miss'), 1, 'the miss is counted, as a hash');
select is((select count(*)::int from private.rate_hits where key_hash = convert_to('198.51.100.7', 'UTF8')), 0, 'never the raw address');
set local role anon;
select is((select count(*)::int from generate_series(1, 29) g where public.feed_calendar_guarded('y' || repeat('B', 42) || g, '198.51.100.7') is null), 29, '29 more misses');
select throws_ok($$ select public.feed_calendar_guarded(current_setting('test.token'), '198.51.100.7') $$, 'P0429', null,
  'after 30 misses in 10 minutes, that address must wait, even with a real token');
select is(public.feed_calendar_guarded(current_setting('test.token'), '198.51.100.8') -> 'feed' ->> 'name', 'Hardening cal', 'other addresses are unaffected');
select is(public.feed_calendar_guarded(current_setting('test.token'), '198.51.100.7', 'Google-Calendar-Importer', 'google') -> 'feed' ->> 'name', 'Hardening cal',
  'Google''s shared fetchers are exempt');
select is(public.feed_calendar_guarded(current_setting('test.token')) -> 'feed' ->> 'name', 'Hardening cal', 'no address (local development): no limit');
reset role;

-- ---------------------------------------------------------------- public rate checks
set local role anon;
select is((select count(*)::int from generate_series(1, 60) g where public.rate_check('search', '203.0.113.9')), 60, '60 searches a minute are fine');
select is(public.rate_check('search', '203.0.113.9'), false, 'the 61st waits');
select is(public.rate_check('click', '203.0.113.9'), true, 'buckets are separate');
select is(public.rate_check('feed_miss', '203.0.113.10'), false, 'only the search and click buckets can be used from outside');
reset role;
select throws_ok($$ select private.rate_ok('nope', '1.2.3.4') $$, null, null, 'an unknown bucket is an error, not a silent pass');

-- ---------------------------------------------------------------- export
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is(public.export_my_data() -> 'account' ->> 'email', 'hardening@example.test', 'the export has the account');
select is(public.export_my_data() #>> '{feeds,0,feed,name}', 'Hardening cal', 'its feeds');
select is(public.export_my_data() #>> '{feeds,0,events,0,title}', 'Practice', 'and their events');
select ok(not (public.export_my_data() #> '{feeds,0,feed}' ? 'feed_token_hash'), 'but no token hash or secret id');
reset role;
set local role anon;
select throws_ok($$ select public.export_my_data() $$, '42501', null, 'anon cannot export anything');
reset role;

-- ---------------------------------------------------------------- deletion
insert into public.supporters (supporter_hash, display_name, user_id) values (private.email_hash('hardening@example.test'), 'H', 'd1600000-0000-4000-8000-000000000001');
select lives_ok($$ select public.purge_account_data('d1600000-0000-4000-8000-000000000001') $$, 'purge');
select is((select count(*)::int from public.supporters where supporter_hash = private.email_hash('hardening@example.test')), 0, 'a linked supporter record is deleted with the account');
select is((select count(*)::int from public.feeds where id = 'd1610000-0000-4000-8000-000000000001'), 0, 'a feed with no co-editor is deleted');
select is((select schedule from cron.job where jobname = 'feedcal-delete-accounts'), '41 4 * * *', 'account purges run every day');
select is((select schedule from cron.job where jobname = 'feedcal-purge-rate-hits'), '7 * * * *', 'old rate-limit rows are cleared hourly');

-- Retention
insert into public.feeds (id, owner_id, name, slug) values ('d1610000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'Old stats', 'old-stats-x');
insert into public.feed_fetch_daily (feed_id, day, client_hash) values
  ('d1610000-0000-4000-8000-000000000002', current_date - 401, extensions.gen_random_bytes(32)),
  ('d1610000-0000-4000-8000-000000000002', current_date - 10, extensions.gen_random_bytes(32));
insert into private.email_outbox (user_id, kind, dedupe_key, payload, state, created_at) values
  ('11111111-1111-4111-8111-111111111111', 'report', 'ret-old', '{"details":"a subscriber note"}', 'sent', now() - interval '31 days'),
  ('11111111-1111-4111-8111-111111111111', 'report', 'ret-new', '{"details":"recent"}', 'sent', now() - interval '1 day');
select is(private.apply_retention() ->> 'fetch_rows_deleted', '1', 'fetch counts older than 400 days are deleted');
select is((select count(*)::int from public.feed_fetch_daily where feed_id = 'd1610000-0000-4000-8000-000000000002'), 1, 'recent counts stay');
select is((select payload from private.email_outbox where dedupe_key = 'ret-old'), '{}'::jsonb, 'an old sent email''s contents are emptied');
select is((select payload ->> 'details' from private.email_outbox where dedupe_key = 'ret-new'), 'recent', 'a recent one is kept');
select is((select schedule from cron.job where jobname = 'feedcal-retention'), '23 5 * * *', 'retention runs daily');

select * from finish();
rollback;
