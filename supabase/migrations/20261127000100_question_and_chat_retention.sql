-- D92: follower questions and chat messages get a stated lifetime.
--
-- Before this, both stayed until their event or calendar was deleted, and the Privacy page gave
-- no period for either. Now the daily retention job:
--   * deletes questions and chat messages 30 days after their event is over (for a repeating
--     event: after its last listed date);
--   * clears the scrambled code on a question once it is an hour old (the job runs daily, so
--     within about a day). It was stored "for the hourly limit
--     only", and that limit is counted in private.report_limits, which already forgets after an hour.
-- Chat keeps its scrambled code for as long as the message lives: it is what gives one person
-- one made-up name.
create or replace function private.apply_retention()
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_fetch integer;
  v_outbox integer;
  v_questions integer;
  v_chat integer;
  v_hashes integer;
begin
  delete from public.feed_fetch_daily where day < current_date - 400;
  get diagnostics v_fetch = row_count;
  update private.email_outbox set payload = '{}'::jsonb, last_error = null
    where state in ('sent', 'failed') and created_at < now() - interval '30 days' and payload <> '{}'::jsonb;
  get diagnostics v_outbox = row_count;

  delete from public.event_questions q using public.events e
    where e.id = q.event_id and private.event_over_since(e) < now() - interval '30 days';
  get diagnostics v_questions = row_count;
  delete from public.event_chat_messages m using public.events e
    where e.id = m.event_id and private.event_over_since(e) < now() - interval '30 days';
  get diagnostics v_chat = row_count;
  update public.event_questions set asker_hash = null
    where asker_hash is not null and created_at < now() - interval '1 hour';
  get diagnostics v_hashes = row_count;

  return jsonb_build_object('fetch_rows_deleted', v_fetch, 'outbox_payloads_cleared', v_outbox,
    'questions_deleted', v_questions, 'chat_messages_deleted', v_chat, 'question_codes_cleared', v_hashes);
end;
$$;
revoke all on function private.apply_retention() from public;

-- When an event ended, by the same reading as private.chat_is_open (D84): no end time counts as
-- an hour, an all-day event lasts through its last day, and a repeating event ends with its last
-- listed date.
create function private.event_over_since(e public.events)
returns timestamptz
language sql stable set search_path = ''
as $$
  select greatest(
    coalesce(e.ends_at, e.starts_at)
      + case when e.all_day then interval '1 day' when e.ends_at is null then interval '1 hour' else interval '0' end,
    (select max(o) from unnest(e.occurrences) o));
$$;
revoke all on function private.event_over_since(public.events) from public, anon, authenticated;
