-- D41: a trusted sender's event publishes at 50% when the email's words prove the date (checked in
-- code: event_candidates.date_confirmed); otherwise the feed's bar (70% since D70) applies; review reasons
-- (ambiguous date, mismatch, before the email) always wait; strangers always wait.
begin;
select * from no_plan();
select pgmq.purge_queue('reconcile_message');
delete from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001';

create function pg_temp.cand(p_title text, p_day int, p_conf numeric, p_confirmed boolean, p_review text[] default '{}', p_trusted boolean default true)
returns uuid language plpgsql as $$
declare m uuid := gen_random_uuid(); v uuid := gen_random_uuid();
begin
  insert into public.messages (id, feed_id, source_id, status, original_subject)
  values (m, 'aaaaaaaa-0000-4000-8000-000000000001', case when p_trusted then 'cccccccc-0000-4000-8000-000000000001'::uuid end, 'extracted', p_title);
  insert into public.event_candidates (id, message_id, feed_id, title, starts_at, all_day, timezone, change_kind, confidence,
                                       evidence_quote, source_kind, review_reasons, date_confirmed)
  values (v, m, 'aaaaaaaa-0000-4000-8000-000000000001', p_title, '2026-12-01 08:00+00'::timestamptz + make_interval(days => p_day * 3), true, 'America/Los_Angeles', 'new', p_conf,
          'quoted ' || p_title, 'body', p_review, p_confirmed);
  perform pgmq.send('reconcile_message', jsonb_build_object('message_id', m));
  return v;
end $$;
create function pg_temp.published(p_title text) returns boolean language sql as $$
  select published from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001' and title = p_title $$;

select pg_temp.cand('Alpha recital', 1, 0.55, true);
select pg_temp.cand('Bravo bake sale', 2, 0.55, false);
select pg_temp.cand('Charlie field trip', 3, 0.90, false);
select pg_temp.cand('Delta picture day', 4, 0.45, true, '{low_confidence}');
select pg_temp.cand('Echo pajama day', 5, 0.90, false, '{ambiguous_date}');
select pg_temp.cand('Foxtrot book fair', 6, 0.95, true, '{}', false);
select pg_temp.cand('Golf game night', 7, 0.72, false);
select pg_temp.cand('Hotel spirit week', 8, 0.68, false);
select public.reconcile_pending(100);

select is(pg_temp.published('Alpha recital'), true, 'a date the email proves publishes at 55%');
select is(pg_temp.published('Bravo bake sale'), false, 'an unproven date at 55% waits (the feed''s 70% bar)');
select is(pg_temp.published('Charlie field trip'), true, 'an unproven date above the bar still publishes');
select is(pg_temp.published('Delta picture day'), false, 'below 50% always waits');
select is(pg_temp.published('Echo pajama day'), false, 'an ambiguous date waits however sure the model is');
select is(pg_temp.published('Foxtrot book fair'), false, 'an unapproved sender always waits');
select is(pg_temp.published('Golf game night'), true, 'D70: an unproven date at 72% publishes (the standard bar is 70%)');
select is(pg_temp.published('Hotel spirit week'), false, 'D70: at 68% it waits');

select * from finish();
rollback;
