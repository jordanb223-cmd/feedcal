-- Sign-in email limits: 5 per address and 20 per IP per hour; hashes only; refusals not counted.
begin;
select plan(9);

set local role anon;
select ok(public.login_attempt_allowed('limit@example.test', '198.51.100.1'), 'attempt 1 allowed');
select ok(public.login_attempt_allowed('limit@example.test', '198.51.100.2'), 'attempt 2 allowed');
select ok(public.login_attempt_allowed('LIMIT@example.test ', '198.51.100.3'), 'case and spaces count as the same address');
select ok(public.login_attempt_allowed('limit@example.test', '198.51.100.4'), 'attempt 4 allowed');
select ok(public.login_attempt_allowed('limit@example.test', '198.51.100.5'), 'attempt 5 allowed');
select ok(not public.login_attempt_allowed('limit@example.test', '198.51.100.6'), 'attempt 6 for the same address is refused');
reset role;

-- 20 per IP, across different addresses.
select is((select count(*)::int from generate_series(1, 25) i
           where public.login_attempt_allowed('ip' || i || '@example.test', '203.0.113.9')), 20,
  'one IP gets 20 attempts an hour, across addresses');

select is((select count(*)::int from private.login_attempts
           where octet_length(email_hash) <> 32
              or position(convert_to('limit@example.test', 'UTF8') in email_hash) > 0), 0,
  'only 32-byte hashes are stored, never the address');

-- Old attempts stop counting.
update private.login_attempts set at = now() - interval '61 minutes';
select ok(public.login_attempt_allowed('limit@example.test', '198.51.100.7'), 'after an hour the address can try again');

select * from finish();
rollback;
