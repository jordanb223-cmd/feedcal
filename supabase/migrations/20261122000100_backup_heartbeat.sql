-- D65: GitHub drops scheduled workflow runs under load (its docs: "some queued jobs may be
-- dropped"), and the daily backup never ran on schedule. Backups now run four times a day, and
-- every successful backup (scheduled, manual or pre-deploy) records a heartbeat here through
-- scripts/backup.sh. The 5-minute alert check emails the admins when the newest backup is more
-- than 30 hours old. The alarm arms on the first real backup, so staging (no backups) stays quiet.

create table private.backup_heartbeat (
  id boolean primary key default true check (id),
  taken_at timestamptz,            -- null until the first real backup
  source text,
  bytes bigint check (bytes is null or bytes >= 0)
);
alter table private.backup_heartbeat enable row level security;
revoke all on table private.backup_heartbeat from public, anon, authenticated;
insert into private.backup_heartbeat (id) values (true);

create function private.record_backup(p_source text, p_bytes bigint)
returns timestamptz
language sql volatile security definer set search_path = ''
as $$
  update private.backup_heartbeat set taken_at = now(), source = left(coalesce(p_source, 'unknown'), 40), bytes = p_bytes
  where id returning taken_at
$$;
revoke all on function private.record_backup(text, bigint) from public, anon, authenticated;

create or replace function private.alert_thresholds()
returns jsonb
language sql immutable set search_path = ''
as $$ select '{
  "queue_backlog_minutes": 15,
  "email_failures_per_hour": 5,
  "email_failure_share": 0.2,
  "purge_overdue_days": 1,
  "rate_hits_per_10_minutes": 500,
  "backup_stale_hours": 30
}'::jsonb $$;

alter table private.alerts drop constraint alerts_kind_check;
alter table private.alerts add constraint alerts_kind_check
  check (kind in ('queue_backlog', 'ai_spend_daily', 'ai_throttle', 'email_failures', 'purge_stuck', 'abuse_spike', 'backup_stale'));

create or replace function private.check_alerts(p_drill boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  t jsonb := private.alert_thresholds();
  s jsonb := private.spend_status();
  v_now jsonb := '{}'::jsonb;
  v_kind text;
  v_detail jsonb;
  v_opened text[] := '{}';
  v_failed integer;
  v_total integer;
  v_id bigint;
begin
  -- queue backlog: the oldest message in any pipeline queue
  select jsonb_build_object('queue', m.queue_name, 'oldest_minutes', round(m.oldest_msg_age_sec / 60.0, 1)) into v_detail
  from (select (pgmq.metrics(q)).* from unnest(array['process_message', 'triage_message', 'extract_message', 'reconcile_message']) q) m
  where m.oldest_msg_age_sec > (t ->> 'queue_backlog_minutes')::int * 60
  order by m.oldest_msg_age_sec desc limit 1;
  if v_detail is not null or p_drill then v_now := v_now || jsonb_build_object('queue_backlog', coalesce(v_detail, '{}')); end if;

  if (s ->> 'today_usd')::numeric > (s ->> 'daily_budget_usd')::numeric or p_drill then
    v_now := v_now || jsonb_build_object('ai_spend_daily', jsonb_build_object('today_usd', s -> 'today_usd', 'daily_budget_usd', s -> 'daily_budget_usd'));
  end if;
  if (s ->> 'throttled')::boolean or p_drill then
    v_now := v_now || jsonb_build_object('ai_throttle', jsonb_build_object('month_usd', s -> 'month_usd', 'monthly_budget_usd', s -> 'monthly_budget_usd'));
  end if;

  select count(*) filter (where state = 'failed'), count(*) into v_failed, v_total
  from private.email_outbox where created_at > now() - interval '1 hour' and state <> 'queued';
  if (v_failed >= (t ->> 'email_failures_per_hour')::int and v_failed >= v_total * (t ->> 'email_failure_share')::numeric) or p_drill then
    v_now := v_now || jsonb_build_object('email_failures', jsonb_build_object('failed', v_failed, 'of', v_total));
  end if;

  if exists (select 1 from public.profiles where deleted_at is not null
             and deleted_at <= now() - make_interval(days => 14 + (t ->> 'purge_overdue_days')::int)) or p_drill then
    v_now := v_now || jsonb_build_object('purge_stuck', jsonb_build_object('overdue', (select count(*) from public.profiles
      where deleted_at is not null and deleted_at <= now() - make_interval(days => 14 + (t ->> 'purge_overdue_days')::int))));
  end if;

  if (select count(*) from private.rate_hits where at > now() - interval '10 minutes') > (t ->> 'rate_hits_per_10_minutes')::int or p_drill then
    v_now := v_now || jsonb_build_object('abuse_spike', jsonb_build_object('rate_hits_10_min', (select count(*) from private.rate_hits where at > now() - interval '10 minutes')));
  end if;

  -- D65: no backup recorded for too long. Armed by the first real backup (staging never backs up).
  if ((select taken_at from private.backup_heartbeat where id) < now() - make_interval(hours => (t ->> 'backup_stale_hours')::int)) or p_drill then
    v_now := v_now || jsonb_build_object('backup_stale', jsonb_build_object(
      'last_backup', (select taken_at from private.backup_heartbeat where id),
      'hours', (select round(extract(epoch from now() - taken_at) / 3600) from private.backup_heartbeat where id)));
  end if;

  -- open or refresh
  for v_kind, v_detail in select key, value from jsonb_each(v_now) loop
    update private.alerts set last_seen_at = now(), detail = v_detail where kind = v_kind and resolved_at is null;
    if not found then
      insert into private.alerts (kind, detail, drill) values (v_kind, v_detail, p_drill) returning id into v_id;
      v_opened := v_opened || v_kind;
      perform private.enqueue_email(a.user_id, 'ops_alert', 'ops_alert:' || v_id || ':' || a.user_id,
                                    jsonb_build_object('kind', v_kind, 'detail', v_detail, 'drill', p_drill))
      from public.admins a;
    end if;
  end loop;
  -- resolve what's no longer true
  update private.alerts set resolved_at = now() where resolved_at is null and not (v_now ? kind);
  return jsonb_build_object('firing', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(v_now) k), 'opened', to_jsonb(v_opened));
end;
$$;
