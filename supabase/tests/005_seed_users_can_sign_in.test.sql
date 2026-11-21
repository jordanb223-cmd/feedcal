-- Guard for a bug found in Phase 5: seeded auth.users rows with NULL token columns make the
-- auth server fail ("converting NULL to string is unsupported"), so seeded people can't sign in.
-- Runs against the seeded database (CI runs `supabase db reset`, which loads the seed).
begin;
select plan(2);

select is(
  (select count(*)::int from auth.users
   where confirmation_token is null or recovery_token is null or email_change_token_new is null
      or email_change is null or email_change_token_current is null or reauthentication_token is null
      or phone_change is null or phone_change_token is null),
  0, 'no user has NULL token columns (the auth server cannot read them)');

select is(
  (select count(*)::int from auth.users u where not exists (select 1 from auth.identities i where i.user_id = u.id)),
  0, 'every user has an identity row');

select * from finish();
rollback;
