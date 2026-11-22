-- D65: the backup alarm. Quiet until the first real backup (staging never backs up), quiet while
-- backups are fresh, fires after 30 hours without one, clears when one arrives. Server-only.
begin;
select * from no_plan();
delete from private.alerts;
update private.backup_heartbeat set taken_at = null, source = null, bytes = null;

select is(has_function_privilege('anon', 'private.record_backup(text, bigint)', 'execute'), false, 'nobody outside can record a backup');
select is(has_function_privilege('authenticated', 'private.record_backup(text, bigint)', 'execute'), false, 'not even signed-in users');
select is(has_table_privilege('authenticated', 'private.backup_heartbeat', 'update'), false, 'nor change the heartbeat');

select ok(not (private.check_alerts() -> 'firing') ? 'backup_stale', 'no alarm before the first real backup (staging)');
select ok(private.record_backup('scheduled', 714000) > now() - interval '1 minute', 'a backup is recorded');
select ok(not (private.check_alerts() -> 'firing') ? 'backup_stale', 'a fresh backup: quiet');

update private.backup_heartbeat set taken_at = now() - interval '29 hours';
select ok(not (private.check_alerts() -> 'firing') ? 'backup_stale', '29 hours: still quiet');
update private.backup_heartbeat set taken_at = now() - interval '31 hours';
select ok((private.check_alerts() -> 'firing') ? 'backup_stale', '31 hours: the alarm fires');
select is((select (detail ->> 'hours')::int from private.alerts where kind = 'backup_stale' and resolved_at is null), 31, 'it says how long');

select private.record_backup('predeploy', 715000);
select ok(not (private.check_alerts() -> 'firing') ? 'backup_stale', 'a new backup clears it');
select ok((select resolved_at is not null from private.alerts where kind = 'backup_stale' order by id desc limit 1), 'and the alert is resolved');
select is((select source || '|' || bytes from private.backup_heartbeat), 'predeploy|715000', 'the last backup''s source and size are kept');

select * from finish();
rollback;
