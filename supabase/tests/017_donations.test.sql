-- Phase 15: Buy Me a Coffee events count once; test events are ignored outside staging; support
-- links to an account only when the person asks; supporter data stays private.
begin;
select * from no_plan();
delete from private.bmc_events;  -- start clean (rolled back)
delete from public.supporters;
delete from private.email_outbox where kind = 'supporter_thanks';

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;

-- Only the webhook (service role) can record events.
set local role authenticated;
select throws_ok($$ select public.record_bmc_event(1, 'donation.created', true, 'alice@example.test', 'Alice', 500, 'USD') $$, '42501', null, 'a signed-in user cannot forge a donation');
reset role;
set local role anon;
select throws_ok($$ select public.record_bmc_event(1, 'donation.created', true, 'alice@example.test', 'Alice', 500, 'USD') $$, '42501', null, 'nor can anyone else');
reset role;

set local role service_role;
select is(public.record_bmc_event(1, 'donation.created', true, 'Alice@Example.test ', 'Alice', 500, 'usd'), 'applied', 'a live donation is applied');
select is(public.record_bmc_event(1, 'donation.created', true, 'Alice@Example.test ', 'Alice', 500, 'usd'), 'duplicate', 'a retried delivery counts once');
select is(public.record_bmc_event(2, 'donation.created', false, 'alice@example.test', 'Alice', 500, 'USD'), 'test_ignored', 'a dashboard test event is ignored in production');
select is(public.record_bmc_event(3, 'donation.created', false, 'test@example.test', 'Tester', 300, 'USD', true), 'applied', '...and accepted where staging asks');
select is(public.record_bmc_event(4, 'extra.purchased', true, 'alice@example.test', 'Alice', 900, 'USD'), 'ignored', 'other event types are ignored');
select is(public.record_bmc_event(5, 'donation.created', true, null, null, 500, 'USD'), 'no_supporter', 'an event without an email changes nothing');
select is(public.record_bmc_event(6, 'membership.started', true, 'alice@example.test', null, null, null), 'applied', 'a membership starts');
reset role;
select is((select row(donations, total_cents, currency, member, display_name, user_id)::text from public.supporters where supporter_hash = private.email_hash('alice@example.test')),
  row(1, 500::bigint, 'USD', true, 'Alice', null::uuid)::text, 'one donation, $5, a member, not linked to any account');
select is((select count(*)::int from private.bmc_events), 6, 'every delivery is recorded once by event id');
set local role service_role;
select is(public.record_bmc_event(7, 'donation.refunded', true, 'alice@example.test', null, 500, 'USD'), 'applied', 'a refund');
select is(public.record_bmc_event(8, 'membership.cancelled', true, 'alice@example.test', null, null, null), 'applied', 'a cancellation');
reset role;
select is((select row(total_cents, member)::text from public.supporters where supporter_hash = private.email_hash('alice@example.test')), row(0::bigint, false)::text, 'refunded and no longer a member');

-- Nothing is readable directly; anon sees only people who chose to be listed.
set local role anon;
select throws_ok($$ select * from public.supporters $$, '42501', null, 'anon cannot read supporters');
select is((select count(*)::int from public.public_supporters()), 0, 'nobody is listed by default');
reset role;
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok($$ select * from public.supporters $$, '42501', null, 'a signed-in user cannot read supporters');
select is(public.link_supporter(), false, 'Bob has no support under his email, so nothing links');
reset role;

-- Alice links (opt-in), gets a thank-you once, then chooses to be listed.
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is((public.my_supporter_status() ->> 'linked')::boolean, false, 'not linked before she asks');
select is(public.link_supporter(), true, 'Alice links her support');
select is(public.link_supporter(), true, 'linking again is harmless');
select is((public.my_supporter_status() ->> 'linked')::boolean, true, 'now linked');
reset role;
select is((select count(*)::int from private.email_outbox where kind = 'supporter_thanks' and user_id = '11111111-1111-4111-8111-111111111111'), 1, 'one thank-you email');
select isnt((select supporter_since from public.profiles where id = '11111111-1111-4111-8111-111111111111'), null, 'the badge date is set');
set local role anon;
select is((select count(*)::int from public.public_supporters()), 0, 'linked is not listed');
reset role;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select is(public.set_supporter_listing(true), true, 'she chooses to be listed');
reset role;
set local role anon;
select is((select display_name from public.public_supporters()), 'Alice', 'and appears by the name she gave');
reset role;

-- The thank-you's unsubscribe link works.
create temp table tok as select private.unsubscribe_token('11111111-1111-4111-8111-111111111111', 'supporter_thanks') as t;
grant select on tok to anon;
set local role anon;
select is(public.unsubscribe('11111111-1111-4111-8111-111111111111', 'supporter_thanks', (select t from tok)), true, 'the thank-you email''s unsubscribe link works');
reset role;

select * from finish();
rollback;
