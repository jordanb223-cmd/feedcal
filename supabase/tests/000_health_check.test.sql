begin;
select plan(3);

select has_function('public', 'health_check', 'health_check() exists');
select is(public.health_check(), true, 'health_check() returns true');
select function_privs_are('public', 'health_check', array[]::text[], 'anon', array['EXECUTE'], 'anon can execute health_check');

select * from finish();
rollback;
