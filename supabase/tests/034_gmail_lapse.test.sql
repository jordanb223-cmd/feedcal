-- D86: a lapsed Gmail connection. The organizer is reminded every 20 days while it stays lapsed,
-- and after 20 days the public page and the calendar file carry the day it lapsed.
begin;
select * from no_plan();
delete from private.email_outbox where kind = 'gmail_reconnect';

insert into public.feeds (id, owner_id, name, slug, visibility) values
  ('d3400000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Lapse feed', 'lapse-feed-x', 'unlisted');
insert into private.gmail_connections (feed_id, user_id, google_email, sender_email, status, connected_at)
  values ('d3400000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'owner@example.test', 'teacher@school.example.test', 'active', now() - interval '8 days');

create function pg_temp.c() returns private.gmail_connections language sql as $$
  select * from private.gmail_connections where feed_id = 'd3400000-0000-4000-8000-000000000001' $$;
create function pg_temp.page() returns text language sql as $$
  select public.public_feed_page((select slug from public.feeds where id = 'd3400000-0000-4000-8000-000000000001')) -> 'feed' ->> 'source_lapsed_since' $$;
create function pg_temp.cal() returns text language sql as $$
  select public.feed_calendar_guarded(current_setting('test.token')) -> 'feed' ->> 'source_lapsed_since' $$;
create function pg_temp.mails() returns integer language sql as $$
  select count(*)::int from private.email_outbox where kind = 'gmail_reconnect' and dedupe_key like 'gmail_lapsed:%' $$;

-- Read the token as the owner, the only way to get it.
select set_config('request.jwt.claims', json_build_object('sub', '11111111-1111-4111-8111-111111111111', 'role', 'authenticated')::text, true);
set local role authenticated;
select set_config('test.token', public.get_feed_token('d3400000-0000-4000-8000-000000000001'), true);
reset role;

select is((pg_temp.c()).lapsed_at, null, 'a working connection has no lapse');
select is(public.public_feed_page((select slug from public.feeds where id = 'd3400000-0000-4000-8000-000000000001')) -> 'feed' ->> 'name', 'Lapse feed', 'the public page finds the calendar');
select is(pg_temp.page(), null, 'and the page says nothing');

-- Google refuses the token.
set local role service_role;
select public.gmail_check_done('d3400000-0000-4000-8000-000000000001', now(), 'invalid_grant', true);
reset role;
select ok((pg_temp.c()).lapsed_at is not null, 'the lapse is dated when Google refuses the connection');
update private.gmail_connections set lapsed_at = now() - interval '5 days' where feed_id = 'd3400000-0000-4000-8000-000000000001';
set local role service_role;
select public.gmail_check_done('d3400000-0000-4000-8000-000000000001', now(), 'invalid_grant', true);
reset role;
select ok((pg_temp.c()).lapsed_at < now() - interval '4 days', 'a later refusal does not move the date');

-- Under 20 days: no reminder, nothing shown to followers.
select is(private.gmail_reminders(), 0, '5 days lapsed: no 20-day reminder');
select is(pg_temp.page(), null, '5 days lapsed: the page says nothing');
select is(pg_temp.cal(), null, '5 days lapsed: the calendar file says nothing');

-- 20 days.
update private.gmail_connections set lapsed_at = now() - interval '20 days 1 hour' where feed_id = 'd3400000-0000-4000-8000-000000000001';
select is(private.gmail_reminders(), 1, '20 days lapsed: the organizer is reminded');
select is(private.gmail_reminders(), 0, 'once for that mark');
select is((select (payload ->> 'days_lapsed')::int from private.email_outbox where dedupe_key like 'gmail_lapsed:%'), 20, 'the email says 20 days');
select ok(pg_temp.page() is not null, '20 days lapsed: the public page carries the day it lapsed');
select ok(pg_temp.cal() is not null, '20 days lapsed: so does the calendar file');

-- 40 days: the next reminder.
update private.gmail_connections set lapsed_at = now() - interval '40 days 1 hour' where feed_id = 'd3400000-0000-4000-8000-000000000001';
select is(private.gmail_reminders(), 1, '40 days lapsed: reminded again');
select is(pg_temp.mails(), 2, 'two reminders so far');

-- Found long lapsed: one reminder now, not one per mark missed.
update private.gmail_connections set lapsed_at = now() - interval '101 days' where feed_id = 'd3400000-0000-4000-8000-000000000001';
select is(private.gmail_reminders(), 1, '101 days lapsed: one reminder');
select is(private.gmail_reminders(), 0, 'and no backlog of the marks missed');
select is((pg_temp.c()).lapse_reminders, 5, 'counted up to the fifth mark');

-- Reconnecting ends it. (The reconnect function itself needs Google's reply; its text is checked.)
select ok(position('lapsed_at = null, lapse_reminders = 0' in pg_get_functiondef('public.gmail_oauth_complete(text, text, text)'::regprocedure)) > 0,
  'reconnecting clears the lapse');
update private.gmail_connections set status = 'active', lapsed_at = null, lapse_reminders = 0 where feed_id = 'd3400000-0000-4000-8000-000000000001';
select is(pg_temp.page(), null, 'reconnected: the page says nothing again');
select is(pg_temp.cal(), null, 'reconnected: nor does the calendar file');

-- D87: the status page's facts. Anyone may read them; they carry no addresses or subjects.
update private.gmail_connections set status = 'needs_reconnect', lapsed_at = now() - interval '3 days' where feed_id = 'd3400000-0000-4000-8000-000000000001';
set local role anon;
select is(public.feed_status('d3400000-0000-4000-8000-000000000001') ->> 'name', 'Lapse feed', 'anyone with the link can read a calendar''s status');
select is(public.feed_status('d3400000-0000-4000-8000-000000000001') -> 'gmail' ->> 'state', 'disconnected', 'a lapse shows at once, not after 20 days');
select ok((public.feed_status('d3400000-0000-4000-8000-000000000001') -> 'gmail' ->> 'disconnected_since') is not null, 'with the day it began');
select ok(public.feed_status('d3400000-0000-4000-8000-000000000001')::text not like '%school.example.test%'
      and public.feed_status('d3400000-0000-4000-8000-000000000001')::text not like '%owner@example.test%', 'no email address is given away');
select is(public.feed_status('d3400000-0000-4000-8000-0000000000ff'), null, 'an unknown calendar has no status');
reset role;
update public.feeds set visibility = 'private' where id = 'd3400000-0000-4000-8000-000000000001';
set local role anon;
select is(public.feed_status('d3400000-0000-4000-8000-000000000001') -> 'name', 'null'::jsonb, 'a private calendar''s name is not given out');
select is(public.feed_status('d3400000-0000-4000-8000-000000000001') -> 'organizer_name', 'null'::jsonb, 'nor its organizer');
select is(public.feed_status('d3400000-0000-4000-8000-000000000001') -> 'gmail' ->> 'state', 'disconnected', 'its status still is');
reset role;
update private.gmail_connections set status = 'active', lapsed_at = null where feed_id = 'd3400000-0000-4000-8000-000000000001';
select is(public.feed_status('d3400000-0000-4000-8000-000000000001') -> 'gmail' ->> 'state', 'working', 'reconnected: working');
delete from private.gmail_connections where feed_id = 'd3400000-0000-4000-8000-000000000001';
select is(public.feed_status('d3400000-0000-4000-8000-000000000001') -> 'gmail', 'null'::jsonb, 'no Gmail connection: none reported');
update public.feeds set hidden_at = now() where id = 'd3400000-0000-4000-8000-000000000001';
select is(public.feed_status('d3400000-0000-4000-8000-000000000001'), null, 'a hidden calendar has no status page');

select * from finish();
rollback;
