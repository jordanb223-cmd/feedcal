-- Phase 18: operations (D38). An AI spend ledger, a monthly budget with an automatic throttle at
-- 80%, and alerts checked every 5 minutes that email the admins: queue backlog, AI spend over
-- the daily budget, the throttle switching on, email failures (the bounce signal we have),
-- account purges stuck, and abuse spikes. A drill fires every alert once.
-- (Site down, errors and feed latency are watched from outside by the uptime workflow.)

-- ---------------------------------------------------------------- spend ledger
-- AI calls already record their estimated cost (pipeline.ts, triage.ts). These triggers copy it
-- into a ledger that outlives the 30-day message retention.
create table private.ai_spend_daily (
  day date primary key default current_date,
  usd numeric(12, 4) not null default 0 check (usd >= 0)
);
alter table private.ai_spend_daily enable row level security;
revoke all on table private.ai_spend_daily from public, anon, authenticated;

create function private.add_ai_spend(p_usd numeric)
returns void
language sql volatile set search_path = ''
as $$
  insert into private.ai_spend_daily (day, usd) values (current_date, greatest(coalesce(p_usd, 0), 0))
  on conflict (day) do update set usd = private.ai_spend_daily.usd + excluded.usd
$$;

create function private.messages_track_spend()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if jsonb_typeof(new.extraction -> 'calls') = 'array' and new.extraction -> 'calls' is distinct from coalesce(old.extraction -> 'calls', 'null'::jsonb) then
    perform private.add_ai_spend((select sum((c ->> 'costUsd')::numeric) from jsonb_array_elements(new.extraction -> 'calls') c));
  end if;
  return new;
end;
$$;
create trigger messages_track_spend after update of extraction on public.messages
  for each row execute function private.messages_track_spend();

create function private.attachments_track_spend()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.triage ? 'costUsd' and new.triage -> 'costUsd' is distinct from coalesce(old.triage -> 'costUsd', 'null'::jsonb) then
    perform private.add_ai_spend((new.triage ->> 'costUsd')::numeric);
  end if;
  return new;
end;
$$;
create trigger attachments_track_spend after update of triage on public.attachments
  for each row execute function private.attachments_track_spend();

-- ---------------------------------------------------------------- budget and throttle
create table private.ops_settings (
  id boolean primary key default true check (id),
  monthly_ai_budget_usd numeric(10, 2) not null default 10 check (monthly_ai_budget_usd >= 0),
  throttle_at numeric(3, 2) not null default 0.80 check (throttle_at > 0 and throttle_at <= 1)
);
insert into private.ops_settings default values;
alter table private.ops_settings enable row level security;
revoke all on table private.ops_settings from public, anon, authenticated;

create function private.spend_status()
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'today_usd', coalesce((select usd from private.ai_spend_daily where day = current_date), 0),
    'month_usd', coalesce((select sum(usd) from private.ai_spend_daily where day >= date_trunc('month', current_date)::date), 0),
    'monthly_budget_usd', s.monthly_ai_budget_usd,
    'daily_budget_usd', round(s.monthly_ai_budget_usd / 30, 4),
    'throttle_at', s.throttle_at,
    'throttled', coalesce((select sum(usd) from private.ai_spend_daily where day >= date_trunc('month', current_date)::date), 0)
                 >= s.monthly_ai_budget_usd * s.throttle_at)
  from private.ops_settings s
$$;

-- As Phase 9's take_quota, plus: AI work (vision pages, AI calls) gets nothing while the month's
-- spend is at or over 80% of the budget. Messages then wait and are retried later (D30).
create or replace function public.take_quota(p_feed_id uuid, p_kind text, p_wanted integer)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_owner uuid;
  v_limit integer := (private.triage_limits() ->> (p_kind || '_per_day'))::int;
  v_used integer;
  v_grant integer;
begin
  select owner_id into v_owner from public.feeds where id = p_feed_id;
  if v_owner is null or v_limit is null or p_wanted <= 0 then
    return 0;
  end if;
  if p_kind in ('vision_pages', 'ai_calls') and (private.spend_status() ->> 'throttled')::boolean then
    return 0;
  end if;
  insert into private.usage_daily (user_id, kind) values (v_owner, p_kind) on conflict do nothing;
  select amount into v_used from private.usage_daily where user_id = v_owner and day = current_date and kind = p_kind for update;
  v_grant := greatest(0, least(p_wanted, v_limit - v_used));
  update private.usage_daily set amount = amount + v_grant where user_id = v_owner and day = current_date and kind = p_kind;
  return v_grant;
end;
$$;

-- ---------------------------------------------------------------- alerts
create table private.alerts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('queue_backlog', 'ai_spend_daily', 'ai_throttle', 'email_failures', 'purge_stuck', 'abuse_spike')),
  detail jsonb not null default '{}'::jsonb,
  drill boolean not null default false,
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index alerts_one_open_idx on private.alerts (kind) where resolved_at is null;
alter table private.alerts enable row level security;
revoke all on table private.alerts from public, anon, authenticated;

alter table private.email_outbox drop constraint email_outbox_kind_check;
alter table private.email_outbox add constraint email_outbox_kind_check
  check (kind in ('weekly_digest', 'report', 'stale_nudge', 'milestone', 'supporter_thanks', 'ops_alert'));

-- Thresholds, defined once.
create function private.alert_thresholds()
returns jsonb
language sql immutable set search_path = ''
as $$ select '{
  "queue_backlog_minutes": 15,
  "email_failures_per_hour": 5,
  "email_failure_share": 0.2,
  "purge_overdue_days": 1,
  "rate_hits_per_10_minutes": 500
}'::jsonb $$;

-- Evaluates every condition. A condition that's true opens an alert (once) and emails each admin;
-- one that's false resolves its open alert. p_drill forces every condition true, for drills.
create function private.check_alerts(p_drill boolean default false)
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
revoke all on function private.check_alerts(boolean) from public;
select cron.schedule('feedcal-check-alerts', '*/5 * * * *', $$ select private.check_alerts() $$);

-- For the admin console (second factor required, like every admin action).
create function public.admin_ops()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Admins only, with a second factor.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'spend', private.spend_status(),
    'open_alerts', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'detail', detail, 'opened_at', opened_at, 'drill', drill) order by opened_at)
                             from private.alerts where resolved_at is null), '[]'::jsonb),
    'recent_alerts', coalesce((select jsonb_agg(x) from (select jsonb_build_object('kind', kind, 'opened_at', opened_at, 'resolved_at', resolved_at, 'drill', drill) x
                               from private.alerts order by opened_at desc limit 20) y), '[]'::jsonb));
end;
$$;
revoke all on function public.admin_ops() from public, anon;
grant execute on function public.admin_ops() to authenticated;

-- Drills are audited like other admin actions; they have no single target row.
alter table public.admin_audit drop constraint admin_audit_action_check;
alter table public.admin_audit add constraint admin_audit_action_check check (action in ('hide_feed', 'unhide_feed', 'suspend_user',
  'unsuspend_user', 'verify_feed', 'unverify_feed', 'dismiss_report', 'clear_flag', 'alert_drill'));
alter table public.admin_audit drop constraint admin_audit_target_type_check;
alter table public.admin_audit add constraint admin_audit_target_type_check check (target_type in ('feed', 'user', 'report', 'flag', 'system'));
alter table public.admin_audit alter column target_id drop not null;

-- The staging drill: every alert fires once (emails marked as a drill), then everything that
-- isn't really true resolves. Admin with a second factor only, audited.
create function public.admin_alert_drill()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_fired jsonb;
begin
  if not private.is_admin() then
    raise exception 'Admins only, with a second factor.' using errcode = '42501';
  end if;
  v_fired := private.check_alerts(true);
  perform private.check_alerts(false);
  insert into public.admin_audit (admin_id, action, target_type, target_id, reason)
    values ((select auth.uid()), 'alert_drill', 'system', null, 'fired: ' || (v_fired ->> 'opened'));
  return v_fired;
end;
$$;
revoke all on function public.admin_alert_drill() from public, anon;
grant execute on function public.admin_alert_drill() to authenticated;
