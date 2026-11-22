-- Phase 18: AI spend ledger, monthly budget throttle, alerts and the alert drill.
begin;
select * from no_plan();
delete from private.ai_spend_daily;  -- start clean (rolled back)
delete from private.alerts;
delete from public.admins;
delete from private.email_outbox where kind = 'ops_alert';
delete from private.rate_hits;
-- Locally nothing drains the queues (pg_cron only calls Edge Functions where the deploy set
-- app_settings), so integration runs leave messages behind. Empty them here (rolled back).
delete from pgmq.q_process_message; delete from pgmq.q_triage_message;
delete from pgmq.q_extract_message; delete from pgmq.q_reconcile_message;
delete from public.profiles where deleted_at is not null and deleted_at < now() - interval '15 days';

create function pg_temp.as_user(p uuid, p_aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated', 'aal', p_aal)::text, true) $$;

insert into public.admins (user_id) values ('11111111-1111-4111-8111-111111111111');

-- ---------------------------------------------------------------- the drill
select pg_temp.as_user('22222222-2222-4222-8222-222222222222', 'aal2');
set local role authenticated;
select throws_ok($$ select public.admin_alert_drill() $$, '42501', null, 'only admins can run the drill');
select throws_ok($$ select public.admin_ops() $$, '42501', null, 'or see the operations panel');
reset role;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111', 'aal2');
set local role authenticated;
select is(jsonb_array_length(public.admin_alert_drill() -> 'opened'), 7, 'the drill fires every alert once');
reset role;
select is((select array_agg(kind order by kind) from private.alerts where drill),
  array['abuse_spike', 'ai_spend_daily', 'ai_throttle', 'backup_stale', 'email_failures', 'purge_stuck', 'queue_backlog'], 'all seven kinds (D65 added backup_stale)');
select is((select count(*)::int from private.email_outbox where kind = 'ops_alert' and payload ->> 'drill' = 'true'), 7, 'each emails the admin, marked as a drill');
select is((select count(*)::int from private.alerts where resolved_at is null), 0, 'and with nothing really wrong, they all resolve');
select is((select action from public.admin_audit order by id desc limit 1), 'alert_drill', 'the drill is audited');

-- ---------------------------------------------------------------- nothing wrong: nothing fires
select is(private.check_alerts() -> 'firing', '[]'::jsonb, 'a quiet system raises no alerts');

-- ---------------------------------------------------------------- a real queue backlog
select pgmq.send('extract_message', '{"message_id": "00000000-0000-4000-8000-000000000000"}');
update pgmq.q_extract_message set enqueued_at = now() - interval '20 minutes';
select is(private.check_alerts() -> 'opened', '["queue_backlog"]'::jsonb, 'a message waiting 20 minutes opens a backlog alert');
select is((select detail ->> 'queue' from private.alerts where kind = 'queue_backlog' and resolved_at is null), 'extract_message', 'naming the queue');
select is(private.check_alerts() -> 'opened', '[]'::jsonb, 'still true 5 minutes later: no second email');
select is((select count(*)::int from private.email_outbox where kind = 'ops_alert' and payload ->> 'kind' = 'queue_backlog' and payload ->> 'drill' = 'false'), 1, 'one email for the backlog');
delete from pgmq.q_extract_message;
select is(private.check_alerts() -> 'firing', '[]'::jsonb, 'once the queue drains, the alert resolves');

-- ---------------------------------------------------------------- spend ledger and throttle
insert into public.feeds (id, owner_id, name, slug) values ('d1800000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Spend', 'spend-x');
insert into public.messages (id, feed_id, subject) values ('d1810000-0000-4000-8000-000000000001', 'd1800000-0000-4000-8000-000000000001', 's');
update public.messages set extraction = '{"state":"done","calls":[{"model":"claude-haiku-5-5","costUsd":0.0012},{"model":"claude-opus-5-5","costUsd":0.0400}]}'
  where id = 'd1810000-0000-4000-8000-000000000001';
select is((select usd from private.ai_spend_daily where day = current_date), 0.0412::numeric, 'AI calls'' estimated cost goes into the ledger');
update public.messages set extraction = extraction || '{"candidates": 2}' where id = 'd1810000-0000-4000-8000-000000000001';
select is((select usd from private.ai_spend_daily where day = current_date), 0.0412::numeric, 'an unrelated update doesn''t count it twice');
insert into public.attachments (id, message_id, filename, mime, bytes) values ('d1820000-0000-4000-8000-000000000001', 'd1810000-0000-4000-8000-000000000001', 'f.pdf', 'application/pdf', 10);
update public.attachments set triage = '{"stage": 4, "costUsd": 0.0088}' where id = 'd1820000-0000-4000-8000-000000000001';
select is((select usd from private.ai_spend_daily where day = current_date), 0.0500::numeric, 'vision transcription cost too');

update private.ops_settings set monthly_ai_budget_usd = 0.06;  -- throttle at 80% = $0.048
select is((private.spend_status() ->> 'throttled')::boolean, true, '$0.05 of a $0.06 budget is past 80%: throttled');
select is(public.take_quota('d1800000-0000-4000-8000-000000000001', 'ai_calls', 1), 0, 'AI calls get nothing while throttled');
select is(public.take_quota('d1800000-0000-4000-8000-000000000001', 'vision_pages', 1), 0, 'nor do vision pages');
select is(public.take_quota('d1800000-0000-4000-8000-000000000001', 'text_pages', 3), 3, 'reading a PDF''s text layer costs nothing and carries on');
select ok(private.check_alerts() -> 'firing' @> '["ai_throttle", "ai_spend_daily"]'::jsonb, 'the throttle and the daily overspend both alert');
update private.ops_settings set monthly_ai_budget_usd = 100;
select is(public.take_quota('d1800000-0000-4000-8000-000000000001', 'ai_calls', 1), 1, 'with room in the budget, AI work resumes');

select pg_temp.as_user('11111111-1111-4111-8111-111111111111', 'aal2');
set local role authenticated;
select is((public.admin_ops() -> 'spend' ->> 'today_usd')::numeric, 0.0500::numeric, 'the admin panel shows today''s spend');
reset role;

select is((select schedule from cron.job where jobname = 'feedcal-check-alerts'), '*/5 * * * *', 'alerts are checked every 5 minutes');

select * from finish();
rollback;
