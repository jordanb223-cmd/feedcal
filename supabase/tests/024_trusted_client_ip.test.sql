-- D51: visitor addresses are trusted only with the web server's proof (x-feedcal-proxy).
begin;
select * from no_plan();
create function pg_temp.headers(p text) returns void language sql as $$
  select set_config('request.headers', p, true) $$;
-- The feed and its calendar link
create temp table t as select ds.decrypted_secret as tok from public.feeds f join vault.decrypted_secrets ds on ds.id = f.feed_token_secret_id
  where f.id = 'aaaaaaaa-0000-4000-8000-000000000001';
grant select on t to anon;
delete from public.feed_fetch_daily where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- Not configured (local development): behaves as before.
select ok(private.proxy_ok(), 'no key configured: addresses are trusted as before');

-- Configured: the deploy's key.
select vault.create_secret('test-proxy-key-0123456789', 'rpc_proxy_key');
select ok(not private.proxy_ok(), 'with a key configured, a call without the header is unproven');

-- The attack: 5 calls with made-up addresses, no proof.
select pg_temp.headers('{}');
set local role anon;
select public.feed_calendar_guarded((select tok from t), '203.0.113.' || i, 'iOS/18.0 dataaccessd/1.0', 'apple') from generate_series(1, 5) i;
reset role;
select is((select count(*)::int from public.feed_fetch_daily where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0,
  'made-up addresses without proof are not counted (the calendar is still served)');
select pg_temp.headers('{"x-feedcal-proxy":"wrong-key"}');
set local role anon;
select public.feed_calendar_guarded((select tok from t), '203.0.113.99', 'iOS/18.0 dataaccessd/1.0', 'apple');
reset role;
select is((select count(*)::int from public.feed_fetch_daily where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0, 'a wrong key is no proof');

-- The web server, with the right key: counted.
select pg_temp.headers('{"x-feedcal-proxy":"test-proxy-key-0123456789"}');
set local role anon;
select isnt(public.feed_calendar_guarded((select tok from t), '198.51.100.7', 'iOS/18.0 dataaccessd/1.0', 'apple'), null, 'the calendar is served');
reset role;
select is((select count(*)::int from public.feed_fetch_daily where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 1, 'with proof, the visit counts');

-- Limits: unproven callers share one bucket however many addresses they invent.
select pg_temp.headers('{}');
set local role anon;
select public.rate_check('click', '192.0.2.' || i) from generate_series(1, 30) i;
select is(public.rate_check('click', '192.0.2.250'), false, 'unproven callers share one limit: inventing addresses gains nothing');
reset role;
select pg_temp.headers('{"x-feedcal-proxy":"test-proxy-key-0123456789"}');
set local role anon;
select is(public.rate_check('click', '192.0.2.250'), true, 'a real visitor (via the web server) has their own limit');
reset role;

-- The unguarded calendar function is not part of the API.
set local role anon;
select throws_ok($$ select public.feed_calendar((select tok from t)) $$, '42501', null, 'the unguarded calendar function is not callable from the API');
reset role;

select * from finish();
rollback;
