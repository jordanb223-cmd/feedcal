-- D63: the contact form. Anyone may send; nobody but the server reads messages; admins get an
-- email; bad input and header tricks are refused; 5 an hour per address; old messages purged.
begin;
select * from no_plan();
delete from private.contact_messages;
delete from private.rate_hits where bucket = 'contact';
insert into public.admins (user_id) values ('11111111-1111-4111-8111-111111111111') on conflict do nothing;

select is(has_function_privilege('anon', 'public.submit_contact(text, text, text, text, text)', 'execute'), true, 'anyone can send a message');
select is(has_table_privilege('anon', 'private.contact_messages', 'select'), false, 'nobody outside can read them');
select is(has_table_privilege('authenticated', 'private.contact_messages', 'select'), false, 'not even signed-in users');
select is(has_function_privilege('anon', 'private.submit_contact_inner(text, text, text, text, text)', 'execute'), false, 'the inner function is server-only');

select is(public.submit_contact('bug', 'The flyer is blank', 'Parent@Example.Test', '/feeds/x/flyer', '10.0.0.1'), 'ok', 'a normal message');
select is((select kind || '|' || reply_to || '|' || page || '|' || signed_in from private.contact_messages), 'bug|parent@example.test|/feeds/x/flyer|false', 'stored, address lower-cased, no account link');
select is((select count(*)::int from private.email_outbox where kind = 'contact' and user_id = '11111111-1111-4111-8111-111111111111'), 1, 'each admin gets an email');

select is(public.submit_contact('nonsense', 'hi', null, null, '10.0.0.2'), 'invalid', 'unknown topic refused');
select is(public.submit_contact('bug', '   ', null, null, '10.0.0.2'), 'invalid', 'empty message refused');
select is(public.submit_contact('bug', repeat('x', 4001), null, null, '10.0.0.2'), 'too_long', 'over 4000 characters refused');
select is(public.submit_contact('bug', 'hi', E'a@b.co\r\nBcc: evil@example.test', null, '10.0.0.2'), 'bad_email', 'a header trick in the address is refused');
select is(public.submit_contact('bug', 'hi', '<a@b.co>', null, '10.0.0.2'), 'bad_email', 'angle brackets refused');
select is(public.submit_contact('bug', 'hi', 'a@b', null, '10.0.0.2'), 'bad_email', 'an address without a domain ending refused');
select is(public.submit_contact('bug', 'hi', 'a,b@c.co', null, '10.0.0.2'), 'bad_email', 'two addresses refused');

select is((select count(*)::int from (select public.submit_contact('other', 'msg ' || g, null, null, '10.0.0.3') r from generate_series(1, 6) g) x where r = 'ok'), 5, 'five an hour from one address');
select is(public.submit_contact('other', 'one more', null, null, '10.0.0.3'), 'too_many', 'then refused');
select is(public.submit_contact('other', 'different address', null, null, '10.0.0.4'), 'ok', 'other addresses are unaffected');
-- Without the website's proof, every caller shares one bucket, so made-up addresses gain nothing.
select vault.create_secret('test-proxy-key-for-028-only-xxxxxxxx', 'rpc_proxy_key');  -- rolled back at the end
select is((select count(*)::int from (select public.submit_contact('other', 'spoof ' || g, null, null, '203.0.113.' || g) r from generate_series(1, 7) g) x where r = 'ok'), 5, 'unproven callers share one limit');

update private.contact_messages set expires_at = now() - interval '1 second' where message = 'The flyer is blank';
select ok(private.purge_contact_messages() >= 1, 'expired messages are purged');
select is((select count(*)::int from private.contact_messages where message = 'The flyer is blank'), 0, 'and gone');

select * from finish();
rollback;
