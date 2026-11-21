-- Phase 14: new-account limits, screening, feed reports, admin actions (aal2), audit, hiding.
begin;
select * from no_plan();
delete from public.admin_audit;  -- start clean, whatever earlier local runs left (rolled back)
delete from public.admins;

create function pg_temp.as_user(p uuid, p_aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated', 'aal', p_aal)::text, true) $$;

-- A brand-new spam account (created now, email confirmed).
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change)
values ('5aa00000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'spammer@spam.example.test', '', now(), now(), now(), '', '', '', '');

-- ---------------------------------------------------------------- day one: no public listing
select pg_temp.as_user('5aa00000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok($$ insert into public.feeds (name, slug, visibility) values ('Cheap pills', 'cheap-pills', 'public') $$, '42501',
  'Public listing opens 7 days after you join. Until then, share it with "anyone with the link".', 'a day-one account cannot list a feed publicly');
select lives_ok($$ insert into public.feeds (name, slug, visibility) values ('My group', 'my-group', 'unlisted') $$, 'it can share by link');
select lives_ok($$ insert into public.feeds (name, slug, visibility) values ('Two', 'two-x', 'private') $$, 'a second feed');
select lives_ok($$ insert into public.feeds (name, slug, visibility, description) values ('Visit bit.ly/free-money', 'three-x', 'unlisted', 'casino bonus') $$, 'a third (flagged) feed');
select throws_ok($$ insert into public.feeds (name, slug, visibility) values ('Four', 'four-x', 'private') $$, '42501', null, 'a new account is capped at 3 feeds');
reset role;
select is((select reasons from public.moderation_flags m join public.feeds f on f.id = m.feed_id where f.name like 'Visit bit.ly%'),
  array['link_shortener', 'spam_words'], 'spammy text is flagged for review');

-- After 7 days: listing needs a published event and no open flag.
update public.profiles set created_at = now() - interval '8 days' where id = '5aa00000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$ update public.feeds set visibility = 'public' where slug like 'my-group%' $$, '42501',
  'A feed needs at least one published event before it can be listed publicly.', 'public listing needs a published event');
reset role;
insert into public.events (feed_id, title, starts_at, published) select id, 'Meetup', now() + interval '3 days', true from public.feeds where slug like 'my-group%';
insert into public.events (feed_id, title, starts_at, published) select id, 'Meetup', now() + interval '3 days', true from public.feeds where name like 'Visit bit.ly%';
set local role authenticated;
select lives_ok($$ update public.feeds set visibility = 'public' where slug like 'my-group%' $$, 'with a published event, after 7 days, it can be listed');
select throws_ok($$ update public.feeds set visibility = 'public' where name like 'Visit bit.ly%' $$, '42501',
  'This feed is waiting for a quick review before it can be listed publicly.', 'a flagged feed waits for review');
reset role;

-- ---------------------------------------------------------------- a report, then one admin click
set local role anon;
select is(public.submit_feed_report((select slug from public.feeds where slug like 'my-group%'), 'spam', 'selling pills', '198.51.100.20'), 'ok', 'anyone can report a feed');
reset role;
insert into public.admins (user_id) values ('11111111-1111-4111-8111-111111111111');
-- (Captured before switching roles: an admin's normal session can't read other people's feeds;
-- the console gets ids from admin_queue().)
create temp table spam as select id, slug from public.feeds where slug like 'my-group%';
grant select on spam to authenticated, anon;

select pg_temp.as_user('11111111-1111-4111-8111-111111111111', 'aal1');
set local role authenticated;
select throws_ok($$ select public.admin_queue() $$, '42501', 'Admins only, with a second factor.', 'an admin without a second factor is refused');
select is(public.admin_status(), '{"aal": "aal1", "is_admin": true}'::jsonb, '...and told why');
reset role;
select pg_temp.as_user('22222222-2222-4222-8222-222222222222', 'aal2');
set local role authenticated;
select throws_ok($$ select public.admin_queue() $$, '42501', null, 'a non-admin with a second factor is refused');
select is((select count(*)::int from public.feed_reports), 0, 'and cannot read reports');
reset role;

select pg_temp.as_user('11111111-1111-4111-8111-111111111111', 'aal2');
set local role authenticated;
select is(jsonb_array_length(public.admin_queue() -> 'reports'), 1, 'the admin sees the report in the queue');
select ok(jsonb_array_length(public.admin_queue() -> 'flags') >= 1, 'and the screening flag');
select lives_ok(format('select public.admin_hide_feed(%L, %L)', (select id from spam), 'spam report'), 'one click hides the feed');
reset role;
select is((select status from public.feed_reports limit 1), 'actioned', 'the report is closed');
select is((select row(action, target_type, reason, admin_id)::text from public.admin_audit order by id desc limit 1),
  row('hide_feed', 'feed', 'spam report', '11111111-1111-4111-8111-111111111111'::uuid)::text, 'with an audit record');
set local role anon;
select is(public.public_feed_page((select slug from spam)), null, 'a hidden feed''s page is gone at once');
select is((select count(*)::int from public.directory_search('Meetup group')), 0, 'and it is out of the directory');
reset role;
select pg_temp.as_user('5aa00000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok($$ update public.feeds set visibility = 'unlisted' where slug like 'my-group%' $$, '42501', null, 'the owner cannot un-hide it by changing visibility');
reset role;

-- Suspend: signed out, feeds hidden; unsuspend restores.
select pg_temp.as_user('11111111-1111-4111-8111-111111111111', 'aal2');
set local role authenticated;
select lives_ok($$ select public.admin_suspend_user('5aa00000-0000-4000-8000-000000000001', 'spam') $$, 'suspend the spammer');
reset role;
select ok((select banned_until > now() from auth.users where id = '5aa00000-0000-4000-8000-000000000001'), 'they are banned in Auth (signed out everywhere)');
select is((select count(*)::int from public.feeds where owner_id = '5aa00000-0000-4000-8000-000000000001' and hidden_at is null), 0, 'all their feeds are hidden');
select is((select count(*)::int from public.admin_audit), 2, 'two audited actions');

-- ---------------------------------------------------------------- verification by domain
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
values ('5aa00000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'coach@riverleague.example.test', '', now(), now(), now(), '', '', '', '');
insert into public.feeds (id, owner_id, name, slug) values ('5aa10000-0000-4000-8000-000000000001', '5aa00000-0000-4000-8000-000000000002', 'River League', 'river-league');
insert into public.sources (feed_id, sender_email, sender_domain, trusted) values ('5aa10000-0000-4000-8000-000000000001', 'news@riverleague.example.test', 'riverleague.example.test', true);
select pg_temp.as_user('5aa00000-0000-4000-8000-000000000002');
set local role authenticated;
select is(public.verify_feed_by_domain('5aa10000-0000-4000-8000-000000000001'), true, 'an owner whose organisation domain sends the feed''s email is verified');
reset role;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok($$ select public.verify_feed_by_domain('5aa10000-0000-4000-8000-000000000001') $$, '42501', null, 'only the owner can ask');
reset role;

select * from finish();
rollback;
