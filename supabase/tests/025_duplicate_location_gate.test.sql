-- D59: when an email repeats an event already on the calendar, only a trusted sender with nothing
-- flagged may fill in the event's missing location. Strangers and flagged emails change nothing.
begin;
select * from no_plan();
select pgmq.purge_queue('reconcile_message');
delete from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001';

create function pg_temp.send(p_title text, p_location text, p_trusted boolean, p_review text[] default '{}')
returns void language plpgsql as $$
declare m uuid := gen_random_uuid();
begin
  insert into public.messages (id, feed_id, source_id, status, original_subject)
  values (m, 'aaaaaaaa-0000-4000-8000-000000000001', case when p_trusted then 'cccccccc-0000-4000-8000-000000000001'::uuid end, 'extracted', p_title);
  insert into public.event_candidates (message_id, feed_id, title, starts_at, all_day, timezone, change_kind, confidence,
                                       evidence_quote, source_kind, review_reasons, date_confirmed, location)
  values (m, 'aaaaaaaa-0000-4000-8000-000000000001', p_title, '2026-12-10 08:00+00', true, 'America/Los_Angeles', 'new', 0.95,
          'quoted ' || p_title, 'body', p_review, true, p_location);
  perform pgmq.send('reconcile_message', jsonb_build_object('message_id', m));
  perform public.reconcile_pending(100);
end $$;
create function pg_temp.loc() returns text language sql as $$
  select location from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001' and title = 'Winter concert' $$;

-- A trusted sender publishes the event, with no location yet.
select pg_temp.send('Winter concert', null, true);
select is((select published from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001' and title = 'Winter concert'), true, 'the original event is published');
select is(pg_temp.loc(), null, 'it has no location yet');

select pg_temp.send('Winter concert', 'Somewhere a stranger chose', false);
select is(pg_temp.loc(), null, 'a stranger repeating the event can''t fill in its location');

select pg_temp.send('Winter concert', 'Flagged place', true, '{possible_injection}');
select is(pg_temp.loc(), null, 'a trusted sender''s flagged email can''t either');

select pg_temp.send('Winter concert', 'School gym', true);
select is(pg_temp.loc(), 'School gym', 'a trusted sender''s clean repeat fills it in');

select pg_temp.send('Winter concert', 'Another place', true);
select is(pg_temp.loc(), 'School gym', 'once set, a repeat never overwrites the location');

select is((select count(*) from public.events where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001' and title = 'Winter concert'), 1::bigint, 'repeats never create a second event');

select * from finish();
rollback;
