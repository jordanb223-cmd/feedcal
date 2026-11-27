-- D94: an organizer has Bumpdraft email one person an invitation. Limits, opt-out, and the
-- address leaving the queue once the email is sent.
begin;
select * from no_plan();

insert into public.feeds (id, owner_id, name, slug, visibility) values
  ('d3900000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Invite feed', 'invite-feed-x', 'unlisted'),
  ('d3900000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'Private feed', 'private-feed-x', 'private');
create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.invite(p_feed uuid, p_email text) returns text language plpgsql as $$
declare r text;
begin
  set local role authenticated;
  r := public.send_invite(p_feed, p_email);
  reset role;
  return r;
end $$;

-- ---------------------------------------------------------------- who and what
select is(pg_temp.invite('d3900000-0000-4000-8000-000000000001', 'pat@example.test'), 'not_allowed', 'nobody signed in: not allowed');
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is(pg_temp.invite('d3900000-0000-4000-8000-000000000001', 'pat@example.test'), 'not_allowed', 'someone who does not run the calendar: not allowed');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.invite('d3900000-0000-4000-8000-000000000001', 'not an address'), 'invalid', 'a bad address is refused');
select is(pg_temp.invite('d3900000-0000-4000-8000-000000000001', E'pat@example.test\nBcc: x@example.test'), 'invalid', 'so is one with a line break');
select is(pg_temp.invite('d3900000-0000-4000-8000-000000000002', 'pat@example.test'), 'private', 'a private calendar has no invitation');
select is((select count(*)::int from private.invites), 0, 'nothing is recorded for any of those');

-- ---------------------------------------------------------------- one invitation
select is(pg_temp.invite('d3900000-0000-4000-8000-000000000001', '  Pat@Example.test '), 'sent', 'the organizer sends one');
select is((select count(*)::int from private.email_outbox where kind = 'invite'), 1, 'one email is queued');
select is((select payload ->> 'to' from private.email_outbox where kind = 'invite'), 'pat@example.test', 'to the address, tidied');
select is((select payload ->> 'slug' from private.email_outbox where kind = 'invite'), (select slug from public.feeds where id = 'd3900000-0000-4000-8000-000000000001'), 'with the calendar''s page');
select ok((select payload ->> 'stop' ~ '^[0-9a-f]{64}$' from private.email_outbox where kind = 'invite'), 'and a stop code');
select ok((select recipient_hash <> convert_to('pat@example.test', 'UTF8') and octet_length(recipient_hash) = 32 from private.invites), 'the log holds a hash, not the address');
select is(pg_temp.invite('d3900000-0000-4000-8000-000000000001', 'PAT@example.test'), 'already', 'the same person is not invited to it twice');

-- ---------------------------------------------------------------- the address leaves the queue
select public.mark_outbox((select id from private.email_outbox where kind = 'invite'), true, 'prov-1');
select is((select payload ? 'to' from private.email_outbox where kind = 'invite'), false, 'once sent, the address is gone from the queue');
select is((select state from private.email_outbox where kind = 'invite'), 'sent', 'and the email is marked sent');

-- ---------------------------------------------------------------- don't email me again
select set_config('test.stop', (select payload ->> 'stop' from private.email_outbox where kind = 'invite'), true);
set local role anon;
select is(public.invite_stop('zz'), false, 'a malformed stop link does nothing');
select is(public.invite_stop(repeat('ab', 32)), false, 'nor does a code nobody was sent');
select is(public.invite_stop(current_setting('test.stop')), true, 'the invited person says stop');
select is(public.invite_stop(current_setting('test.stop')), true, 'twice is fine');
reset role;
select is((select count(*)::int from private.invite_optouts), 1, 'they are on the list once');
-- The private calendar becomes "anyone with the link", with a second person running it.
update public.feeds set visibility = 'unlisted' where id = 'd3900000-0000-4000-8000-000000000002';
insert into public.feed_editors (feed_id, user_id, role) values ('d3900000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'editor');
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is(pg_temp.invite('d3900000-0000-4000-8000-000000000002', 'pat@example.test'), 'opted_out', 'and are not invited to any calendar, by anyone, after that');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');

-- ---------------------------------------------------------------- limits
select is((select count(*)::int from generate_series(1, 9) n where pg_temp.invite('d3900000-0000-4000-8000-000000000001', 'p' || n || '@example.test') = 'sent'), 9, 'nine more go out (ten today)');
select is(pg_temp.invite('d3900000-0000-4000-8000-000000000001', 'eleventh@example.test'), 'limit', 'the eleventh in a day is refused');
insert into private.invites (feed_id, sender_id, recipient_hash)
  select 'd3900000-0000-4000-8000-000000000002', null, extensions.digest('filler' || n, 'sha256') from generate_series(1, 40) n;
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is(pg_temp.invite('d3900000-0000-4000-8000-000000000002', 'late@example.test'), 'busy', 'past 50 a day across the service, everyone waits');

-- ---------------------------------------------------------------- retention
update private.invites set created_at = now() - interval '91 days' where sender_id is null;
select is((private.apply_retention() ->> 'invites_deleted')::int, 40, 'the log is cleared after 90 days');
select is((select count(*)::int from private.invite_optouts), 1, 'the stop list is kept');

select * from finish();
rollback;
