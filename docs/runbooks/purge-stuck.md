# Account purge stuck

Trigger: a `purge_stuck` alert. An account asked to be deleted more than 15 days ago and is still here.

1. **Did the job run?** `select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'feedcal-delete-accounts') order by start_time desc limit 5;`.
2. **Did the function fail?** Supabase → Edge Functions → `delete-accounts` → Logs. The log line `account_purge` has counts: `failed` > 0 means one account errored. The others still went through.
3. **Run it by hand:** `curl -X POST -H "Authorization: Bearer <anon key>" https://<ref>.supabase.co/functions/v1/delete-accounts`.
4. **One account keeps failing:** `select public.purge_account_data('<user id>');` in the SQL editor shows the error. Fix the cause, then run step 3 again. Deletion is a legal promise (14 days), so don't leave it.
