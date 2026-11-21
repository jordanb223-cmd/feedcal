# Queue backlog

Trigger: a `queue_backlog` alert email. A message has waited over 15 minutes in one of `process_message`, `triage_message`, `extract_message` or `reconcile_message`. The alert names the queue.

1. **Is the scheduler running?** In the SQL editor: `select jobname, status, start_time from cron.job_run_details order by start_time desc limit 20;`. Failed runs mean the Edge Function couldn't be called. Check that `private.app_settings` has `functions_url` and `functions_key`.
2. **Is the function failing?** Supabase → Edge Functions → the function for that queue → Logs. Look for repeated errors with the same `request_id` pattern.
3. **Is it AI?** For `extract_message`, check whether AI work is paused: the `ai_throttle` alert, or `/admin` → Operations. Paused messages wait on purpose; see `ai-outage.md`.
4. **One poison message?** `select msg_id, read_ct, enqueued_at from pgmq.q_<queue> order by enqueued_at limit 5;`. A message with a high `read_ct` keeps failing. Archive it (`select pgmq.archive('<queue>', <msg_id>);`) and look at that email in `/feeds/<id>/email`.
5. The alert clears by itself within 5 minutes of the queue draining.
