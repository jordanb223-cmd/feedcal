-- Phase 17: Gmail connection, sender + schedule design. Owner-only; one-time OAuth states with
-- PKCE; the refresh token in Vault; the example must come from the owner's own search results;
-- 3- or 7-day checks; reconnect emails; disconnect deletes everything.
begin;
select * from no_plan();
delete from private.email_outbox where kind = 'gmail_reconnect';

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;

insert into public.feeds (id, owner_id, name, slug) values ('d1700000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Gmail feed', 'gmail-feed-x');
insert into public.feed_editors (feed_id, user_id, role) values ('d1700000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'editor')
  on conflict do nothing;

-- ---------------------------------------------------------------- owner only
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok($$ select public.gmail_start('d1700000-0000-4000-8000-000000000001') $$, '42501', null, 'an editor cannot connect the owner''s Gmail');
reset role;
set local role anon;
select throws_ok($$ select public.gmail_start('d1700000-0000-4000-8000-000000000001') $$, '42501', null, 'nor can anyone signed out');
reset role;

-- ---------------------------------------------------------------- start → callback → complete
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
create temp table st as select public.gmail_start('d1700000-0000-4000-8000-000000000001') as j;
grant select on st to service_role;
reset role;
select ok((select (j ->> 'state') ~ '^[0-9a-f]{64}$' and (j ->> 'code_challenge') ~ '^[A-Za-z0-9_-]{43}$' from st), 'a random state and an S256 PKCE challenge');
select is((select count(*)::int from private.gmail_oauth_states where state_hash = extensions.digest((select j ->> 'state' from st), 'sha256')), 1,
  'only the state''s hash is stored');
set local role service_role;
select is((public.gmail_oauth_verifier((select j ->> 'state' from st)) ->> 'feed_id')::uuid, 'd1700000-0000-4000-8000-000000000001', 'the callback finds the feed');
select is(public.gmail_oauth_verifier('not-a-state'), null, 'an unknown state finds nothing');
select is(public.gmail_oauth_complete((select j ->> 'state' from st), 'owner@gmail.test', 'refresh-token-abc123'),
  'd1700000-0000-4000-8000-000000000001'::uuid, 'connect completes');
select is(public.gmail_oauth_complete((select j ->> 'state' from st), 'x@gmail.test', 'other-token-xyz789'), null, 'a state works once');
reset role;
select is((select count(*)::int from vault.secrets s where s.secret like '%refresh-token-abc123%'), 0, 'the token is encrypted in Vault');

-- ---------------------------------------------------------------- example search, confirm
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.gmail_status('d1700000-0000-4000-8000-000000000001') ->> 'status', 'choose_example', 'connected, waiting for an example');
reset role;
set local role service_role;
select is(public.gmail_token('d1700000-0000-4000-8000-000000000001'), 'refresh-token-abc123', 'the search function can get the token');
select public.gmail_save_candidates('d1700000-0000-4000-8000-000000000001',
  '[{"id":"abc123","from_email":"Office@School.example","from_name":"Room F","subject":"November schedule","date":"2026-11-14T16:00:00Z"},
    {"id":"bad1","from_email":"not an email","from_name":"x","subject":"y","date":"2026-11-10T00:00:00Z"}]');
reset role;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(jsonb_array_length(public.gmail_status('d1700000-0000-4000-8000-000000000001') -> 'candidates'), 2, 'the owner sees the search results');
select is(public.gmail_choose_example('d1700000-0000-4000-8000-000000000001', 'nope', 7), false, 'an email not in their results is refused');
select is(public.gmail_choose_example('d1700000-0000-4000-8000-000000000001', 'bad1', 7), false, 'a result without a real address is refused');
select is(public.gmail_choose_example('d1700000-0000-4000-8000-000000000001', 'abc123', 14), false, '14 days isn''t offered yet (7-day token limit)');
select is(public.gmail_choose_example('d1700000-0000-4000-8000-000000000001', 'abc123', 7), true, 'confirming the example works');
select is(public.gmail_status('d1700000-0000-4000-8000-000000000001') ->> 'sender_email', 'office@school.example', 'only that sender will be searched');
select is((public.gmail_status('d1700000-0000-4000-8000-000000000001') ->> 'interval_days')::int, 7, 'every 7 days');
select is(jsonb_array_length(public.gmail_status('d1700000-0000-4000-8000-000000000001') -> 'candidates'), 0, 'the search results are discarded');
select ok(not (public.gmail_status('d1700000-0000-4000-8000-000000000001') ? 'refresh_token'), 'status never shows the token');
reset role;

-- ---------------------------------------------------------------- checks
set local role service_role;
select is((select row(sender_email, example_gmail_id, last_checked_at)::text from public.gmail_claim_checks(10) where feed_id = 'd1700000-0000-4000-8000-000000000001'),
  row('office@school.example', 'abc123', '2026-11-14 16:00:00+00'::timestamptz)::text, 'due at once: read the example, then mail after its date');
select is((select count(*)::int from public.gmail_claim_checks(10) where feed_id = 'd1700000-0000-4000-8000-000000000001'), 0, 'not claimed twice');
reset role;
insert into public.messages (id, feed_id, subject) values ('d1710000-0000-4000-8000-000000000001', 'd1700000-0000-4000-8000-000000000001', 'From Gmail');
set local role service_role;
select lives_ok($$ select public.gmail_record('d1700000-0000-4000-8000-000000000001', 'abc123', 'd1710000-0000-4000-8000-000000000001', 'queued') $$, 'record the example');
select is(public.gmail_seen('d1700000-0000-4000-8000-000000000001', array['abc123', 'g-2']), array['abc123'], 'seen ones are skipped next time');
select lives_ok($$ select public.gmail_check_done('d1700000-0000-4000-8000-000000000001', '2026-11-21 19:00:00+00') $$, 'check done');
reset role;
select is((select next_check_at from private.gmail_connections where feed_id = 'd1700000-0000-4000-8000-000000000001'),
  '2026-11-28 19:00:00+00'::timestamptz, 'next check in 7 days');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.gmail_set_interval('d1700000-0000-4000-8000-000000000001', 3), true, 'switch to every 3 days');
reset role;
select is((select next_check_at from private.gmail_connections where feed_id = 'd1700000-0000-4000-8000-000000000001'),
  '2026-11-24 19:00:00+00'::timestamptz, 'the next check moves up');

-- Google refuses the token: needs reconnecting, one email to the owner.
set local role service_role;
select public.gmail_check_done('d1700000-0000-4000-8000-000000000001', now(), 'invalid_grant', true);
select public.gmail_check_done('d1700000-0000-4000-8000-000000000001', now(), 'invalid_grant', true);
reset role;
select is((select status from private.gmail_connections where feed_id = 'd1700000-0000-4000-8000-000000000001'), 'needs_reconnect', 'marked for reconnecting');
select is((select count(*)::int from private.email_outbox where kind = 'gmail_reconnect'), 1, 'the owner is emailed once');
select is((select last_checked_at from private.gmail_connections where feed_id = 'd1700000-0000-4000-8000-000000000001'),
  '2026-11-21 19:00:00+00'::timestamptz, 'a failed check doesn''t move the starting point');

-- Reconnecting keeps the sender and schedule.
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
create temp table st2 as select public.gmail_start('d1700000-0000-4000-8000-000000000001') as j;
grant select on st2 to service_role;
reset role;
set local role service_role;
select public.gmail_oauth_complete((select j ->> 'state' from st2), 'owner@gmail.test', 'refresh-token-new456');
reset role;
select is((select row(status, sender_email, interval_days)::text from private.gmail_connections where feed_id = 'd1700000-0000-4000-8000-000000000001'),
  row('active', 'office@school.example', 3)::text, 'reconnected: same sender, same schedule');
select is((select count(*)::int from vault.secrets s join private.gmail_connections c on c.refresh_secret_id = s.id), 1, 'one token in Vault (replaced)');

update private.gmail_connections set connected_at = now() - interval '6 days 1 hour' where feed_id = 'd1700000-0000-4000-8000-000000000001';
select is(private.gmail_reminders(), 1, 'a reminder before the connection expires');
select is(private.gmail_reminders(), 0, 'only once');

-- ---------------------------------------------------------------- disconnect
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.gmail_disconnect('d1700000-0000-4000-8000-000000000001') ->> 'messages_deleted', '1', 'disconnect deletes the messages that came from Gmail');
reset role;
select is((select count(*)::int from private.gmail_connections where feed_id = 'd1700000-0000-4000-8000-000000000001'), 0, 'the connection is gone');
select is((select count(*)::int from vault.secrets where name like 'gmail_refresh:d1700000-0000-4000-8000-000000000001%'), 0, 'and the token');
select is((select count(*)::int from public.messages where id = 'd1710000-0000-4000-8000-000000000001'), 0, 'and the message copy');
select is((select count(*)::int from cron.job where jobname in ('feedcal-gmail-poll', 'feedcal-gmail-reminders')), 2, 'checks and reminders are scheduled');

select * from finish();
rollback;
