-- Phase 3: profile-on-signup trigger and account deletion.
begin;
select * from no_plan();

-- ---------------------------------------------------------------- signup trigger
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_user_meta_data, created_at, updated_at) values
  ('a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'leaving@example.test', '', '{"full_name":"Leaving User"}', now(), now()),
  ('a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'heir@example.test', '', '{}', now(), now()),
  ('a1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'staying@example.test', '', '{}', now(), now());

select is((select display_name from public.profiles where id = 'a1000000-0000-4000-8000-000000000001'), 'Leaving User',
  'signup creates a profile with the Google name');
select is((select count(*)::int from public.profiles where id = 'a1000000-0000-4000-8000-000000000002' and display_name is null), 1,
  'signup without a name creates a profile with no display name');

-- Fixtures: the leaving user owns feed 1 (has an editor) and feed 2 (no editor),
-- and is an editor on feed 3.
insert into public.feeds (id, owner_id, name, slug) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Has heir', 'acct-has-heir'),
  ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'No heir', 'acct-no-heir'),
  ('a2000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'Heir owns', 'acct-heir-owns');
insert into public.feed_editors (feed_id, user_id, role) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'editor'),
  ('a2000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001', 'editor');
insert into public.events (id, feed_id, title, starts_at) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Kept event', now() + interval '1 day');
insert into public.event_revisions (event_id, sequence, diff, cause, actor) values
  ('a3000000-0000-4000-8000-000000000001', 0, '{}', 'manual_edit', 'user:a1000000-0000-4000-8000-000000000001');
select set_config('test.no_heir_secret',
  (select feed_token_secret_id::text from public.feeds where id = 'a2000000-0000-4000-8000-000000000002'), true);

-- ---------------------------------------------------------------- requests (as the user)
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select ok(public.request_account_deletion() between now() + interval '14 days' - interval '1 minute' and now() + interval '14 days' + interval '1 minute',
  'requesting deletion returns a date 14 days out');
select isnt((select deleted_at from public.profiles where id = 'a1000000-0000-4000-8000-000000000001'), null,
  'the user can see their own deletion date');
select lives_ok($$ select public.cancel_account_deletion() $$, 'the user can cancel');
select is((select deleted_at from public.profiles where id = 'a1000000-0000-4000-8000-000000000001'), null, 'cancel clears the date');
select lives_ok($$ select public.request_account_deletion() $$, 'the user can request again');
select throws_ok($$ select public.purge_account_data('a1000000-0000-4000-8000-000000000003') $$, '42501', null,
  'signed-in users cannot purge anyone');
select throws_ok($$ select * from public.due_account_deletions() $$, '42501', null, 'signed-in users cannot list due deletions');
select throws_ok($$ update public.profiles set deleted_at = null $$, '42501', null, 'deleted_at is changed only through the functions');
reset role;

set local role anon;
select throws_ok($$ select public.request_account_deletion() $$, '42501', null, 'anon cannot request deletion');
reset role;

-- ---------------------------------------------------------------- due list
select is((select count(*)::int from public.due_account_deletions() d where d = 'a1000000-0000-4000-8000-000000000001'), 0,
  'a request is not due before 14 days');
update public.profiles set deleted_at = now() - interval '15 days' where id = 'a1000000-0000-4000-8000-000000000001';
update public.profiles set deleted_at = now() - interval '13 days' where id = 'a1000000-0000-4000-8000-000000000003';
select is(array(select * from public.due_account_deletions()), array['a1000000-0000-4000-8000-000000000001'::uuid],
  'only requests older than 14 days are due');

-- ---------------------------------------------------------------- purge (as service role)
set local role service_role;
select is(public.purge_account_data('a1000000-0000-4000-8000-000000000001'),
  '{"feeds_deleted": 1, "feeds_transferred": 1}'::jsonb, 'purge reports one feed handed over and one deleted');
reset role;

select is((select owner_id from public.feeds where id = 'a2000000-0000-4000-8000-000000000001'),
  'a1000000-0000-4000-8000-000000000002'::uuid, 'a feed with an editor goes to that editor');
select is((select role from public.feed_editors where feed_id = 'a2000000-0000-4000-8000-000000000001'
           and user_id = 'a1000000-0000-4000-8000-000000000002'), 'owner', 'the editor becomes the owner');
select is((select count(*)::int from public.events where id = 'a3000000-0000-4000-8000-000000000001'), 1, 'the handed-over feed keeps its events');
select is((select count(*)::int from public.feeds where id = 'a2000000-0000-4000-8000-000000000002'), 0, 'a feed with no editor is deleted');
select is((select count(*)::int from vault.secrets where id = current_setting('test.no_heir_secret')::uuid), 0,
  'the deleted feed''s Vault secret is gone');
select is((select count(*)::int from public.feed_editors where user_id = 'a1000000-0000-4000-8000-000000000001'), 0,
  'the user is removed from every feed');
select is((select actor from public.event_revisions where event_id = 'a3000000-0000-4000-8000-000000000001'), 'system',
  'revision history no longer names the user');
select is((select display_name from public.profiles where id = 'a1000000-0000-4000-8000-000000000001'), null, 'the display name is wiped');

set local role service_role;
select is(public.purge_account_data('a1000000-0000-4000-8000-000000000001'),
  '{"feeds_deleted": 0, "feeds_transferred": 0}'::jsonb, 'running purge twice is safe');
reset role;

delete from auth.users where id = 'a1000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.profiles where id = 'a1000000-0000-4000-8000-000000000001'), 0,
  'deleting the auth user removes the profile');
select is((select count(*)::int from public.feeds where id = 'a2000000-0000-4000-8000-000000000001'), 1,
  'the handed-over feed survives the auth user''s deletion');

select * from finish();
rollback;
