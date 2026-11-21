-- Phase 12: subscriber estimate, reports → instant notice, unsubscribe, digest, nudges, milestones, outbox.
begin;
select * from no_plan();
delete from private.email_outbox;
delete from public.notification_settings; -- defaults (all on), whatever earlier local runs left
delete from public.feed_milestones;

-- ---------------------------------------------------------------- subscriber estimate [Rev 4]
insert into public.feed_fetch_daily (feed_id, day, client_hash, user_agent_family) values
  ('aaaaaaaa-0000-4000-8000-000000000001', current_date, extensions.digest('phone1', 'sha256'), 'apple'),
  ('aaaaaaaa-0000-4000-8000-000000000001', current_date, extensions.digest('phone2', 'sha256'), 'other'),
  ('aaaaaaaa-0000-4000-8000-000000000001', current_date, extensions.digest('google-ip-1', 'sha256'), 'google'),
  ('aaaaaaaa-0000-4000-8000-000000000001', current_date - 1, extensions.digest('google-ip-2', 'sha256'), 'google'),
  ('aaaaaaaa-0000-4000-8000-000000000001', current_date - 10, extensions.digest('old', 'sha256'), 'apple')
on conflict do nothing;
select is(private.subscriber_estimate('aaaaaaaa-0000-4000-8000-000000000001', current_date - 7, current_date), 3,
  'two personal clients + Google counted once (not once per Google address)');
select is(private.subscriber_estimate('aaaaaaaa-0000-4000-8000-000000000001', current_date - 14, current_date - 7), 1, 'last week is counted separately');
select ok(public.public_feed_page('sutterville-kindergarten') -> 'feed' ? 'may_be_out_of_date', 'the public page says whether a feed may be out of date');

-- ---------------------------------------------------------------- reports
create temp table ev as select uid from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001' and published limit 1;
grant select on ev to anon;
set local role anon;
select is(public.submit_report((select uid from ev), 'wrong_details', 'It''s at 9:30', '198.51.100.7'), 'ok', 'anyone with the calendar can report a problem');
select is(public.submit_report('nope@feedcal.app', 'other'), 'not_found', 'an unknown event is not found');
select is(public.submit_report((select uid from ev), 'nonsense'), 'bad_kind', 'kinds are checked');
reset role;
select is((select count(*)::int from private.email_outbox where kind = 'report'), 1, 'the owner gets an instant notice (queued for the minute-ly sender)');
select is((select payload ->> 'details' from private.email_outbox where kind = 'report'), 'It''s at 9:30', 'with the subscriber''s note');
select ok((select reporter_hash is not null and position(convert_to('198.51.100.7', 'UTF8') in reporter_hash) = 0 from public.reports order by created_at desc limit 1),
  'the reporter''s IP is stored only as a hash');
select is((select count(*)::int from generate_series(1, 12) i where public.submit_report((select uid from ev), 'spam', null, '203.0.113.50') = 'ok'), 10,
  'at most 10 reports an hour from one network');

-- ---------------------------------------------------------------- preferences and unsubscribe
create temp table before_unsub as select count(*) as n from private.email_outbox where kind = 'report';
select is(public.unsubscribe('11111111-1111-4111-8111-111111111111', 'report', 'bad'), false, 'a forged unsubscribe token does nothing');
select is(public.unsubscribe('11111111-1111-4111-8111-111111111111', 'report', private.unsubscribe_token('11111111-1111-4111-8111-111111111111', 'report')), true,
  'the signed token unsubscribes');
select is((select instant_reports from public.notification_settings where user_id = '11111111-1111-4111-8111-111111111111'), false, 'from report notices only');
select is((select weekly_digest from public.notification_settings where user_id = '11111111-1111-4111-8111-111111111111'), true, '...not the digest');
select is(public.submit_report((select uid from ev), 'other', null, '192.0.2.1'), 'ok', 'later reports still save');
select is((select count(*) from private.email_outbox where kind = 'report'), (select n from before_unsub), 'but no email goes to someone who turned them off');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.notification_settings), 0, 'people only see their own email settings');
reset role;

-- ---------------------------------------------------------------- weekly digest
select ok(private.queue_weekly_digests() >= 2, 'digests are queued for each person with a feed');
select is(private.queue_weekly_digests(), 0, 'running twice in a week queues nothing more');
select is((select (f ->> 'subscribers')::int from private.email_outbox o, jsonb_array_elements(o.payload -> 'feeds') f
           where o.kind = 'weekly_digest' and o.user_id = '11111111-1111-4111-8111-111111111111' and f ->> 'id' = 'aaaaaaaa-0000-4000-8000-000000000001'), 3,
  'the digest carries this week''s subscriber estimate');
select ok((select payload -> 'feeds' -> 0 ? 'needs_review' and payload -> 'feeds' -> 0 ? 'reports' and payload -> 'feeds' -> 0 ? 'events_added'
           from private.email_outbox where kind = 'weekly_digest' limit 1), 'and events added, items to review, reports');

-- ---------------------------------------------------------------- staleness and milestones
-- (Events first: changing an event bumps its feed's last_updated_at.)
update public.events set starts_at = now() - interval '60 days' where feed_id = 'bbbbbbbb-0000-4000-8000-000000000001';
update public.feeds set last_updated_at = now() - interval '50 days' where id = 'bbbbbbbb-0000-4000-8000-000000000001';
insert into public.feed_fetch_daily (feed_id, day, client_hash, user_agent_family)
  select 'aaaaaaaa-0000-4000-8000-000000000002', current_date, extensions.digest('m' || i, 'sha256'), 'apple' from generate_series(1, 11) i;
select is(private.daily_motivation(), '{"nudges": 1, "milestones": 1}'::jsonb, 'one quiet feed nudged; one feed passed 10 followers');
select is(private.daily_motivation(), '{"nudges": 0, "milestones": 0}'::jsonb, 'never twice for the same quiet spell or milestone');
select is((select milestone from public.feed_milestones where feed_id = 'aaaaaaaa-0000-4000-8000-000000000002'), 10, 'the milestone is recorded');

-- ---------------------------------------------------------------- outbox
create temp table claimed as select * from public.claim_outbox(100);
select ok((select count(*) from claimed) >= 3, 'the sender claims queued mail');
select ok((select bool_and(email is not null and unsubscribe_token ~ '^[0-9a-f]{64}$') from claimed), 'each with an address and an unsubscribe token');
-- Not the stale nudge: the retry check below needs it still queued (this was flaky when it picked it).
select public.mark_outbox(id, true, 'msg-1') from claimed where kind <> 'stale_nudge' limit 1;
select is((select count(*)::int from private.email_outbox where state = 'sent'), 1, 'marked sent');
update private.email_outbox set attempts = 5 where state = 'queued' and kind = 'stale_nudge';
select public.mark_outbox(id, false, null, 'provider down') from private.email_outbox where kind = 'stale_nudge';
select is((select state from private.email_outbox where kind = 'stale_nudge'), 'failed', 'after 5 tries it stops');
set local role authenticated;
select throws_ok($$ select * from public.claim_outbox() $$, '42501', null, 'only the service role sends mail');
reset role;
select ok((select count(*) from cron.job where jobname in ('feedcal-weekly-digest', 'feedcal-daily-motivation', 'feedcal-send-notifications')) = 3, 'digest, motivation and sending are scheduled');

select * from finish();
rollback;
