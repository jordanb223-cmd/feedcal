-- D88 (owner's decision): "Ask the organizer". A follower can send an anonymous question about an
-- event. Only the calendar's organizer and editors see it. When they answer, the question and the
-- answer show on the event's question page for everyone. Followers never talk to each other here.
create table public.event_questions (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  asker_hash bytea check (asker_hash is null or octet_length(asker_hash) = 32),   -- for the hourly limit only
  answer text check (answer is null or char_length(answer) between 1 and 1000),
  answered_at timestamptz,
  answered_by uuid references public.profiles (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'answered', 'hidden')),
  created_at timestamptz not null default now(),
  check ((status = 'answered') = (answer is not null and answered_at is not null))
);
create index event_questions_feed_idx on public.event_questions (feed_id, status, created_at desc);
create index event_questions_event_idx on public.event_questions (event_id, status);
alter table public.event_questions enable row level security;
revoke all on table public.event_questions from anon, authenticated;
-- Members read the questions (never who asked: the hash column is not granted). Writes go through
-- the functions below.
grant select (id, feed_id, event_id, body, answer, answered_at, status, created_at) on table public.event_questions to authenticated;
create policy event_questions_member_select on public.event_questions
  for select to authenticated using (private.is_feed_member(feed_id));

-- A follower asks. Same hourly limit as reports (10 an hour from one place), and at most 30
-- unanswered questions per event, so one event can't be flooded.
create function private.ask_question_inner(p_event_uid text, p_body text, p_client_ip text)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_body text := nullif(left(trim(regexp_replace(coalesce(p_body, ''), '[\u0000-\u0008\u000B\u000C\u000E-\u001F]', '', 'g')), 500), '');
  v_hash bytea;
  v_id uuid;
  m record;
begin
  if v_body is null then
    return 'empty';
  end if;
  select ev.* into e from public.events ev join public.feeds f on f.id = ev.feed_id
  where ev.uid = left(p_event_uid, 200) and ev.published and ev.status <> 'cancelled'
    and f.hidden_at is null and f.delete_requested_at is null;
  if not found then
    return 'not_found';
  end if;
  if p_client_ip is not null then
    v_hash := extensions.digest((select key from private.notification_key) || convert_to(left(p_client_ip, 64), 'UTF8'), 'sha256');
    delete from private.report_limits where at < now() - interval '1 hour';
    if (select count(*) from private.report_limits where reporter_hash = v_hash) >= 10 then
      return 'rate_limited';
    end if;
    insert into private.report_limits (reporter_hash) values (v_hash);
  end if;
  if (select count(*) from public.event_questions q where q.event_id = e.id and q.status = 'open') >= 30 then
    return 'full';
  end if;
  insert into public.event_questions (feed_id, event_id, body, asker_hash) values (e.feed_id, e.id, v_body, v_hash) returning id into v_id;
  -- Told the same way, and under the same setting, as a report about an event.
  for m in select fe.user_id from public.feed_editors fe where fe.feed_id = e.feed_id loop
    perform private.enqueue_email(m.user_id, 'report', 'question:' || v_id || ':' || m.user_id,
      jsonb_build_object('question', true, 'feed_id', e.feed_id, 'feed_name', (select name from public.feeds where id = e.feed_id),
                         'event_id', e.id, 'event_title', e.title, 'starts_at', e.starts_at, 'all_day', e.all_day,
                         'timezone', e.timezone, 'details', v_body));
  end loop;
  return 'ok';
end;
$$;
revoke all on function private.ask_question_inner(text, text, text) from public, anon, authenticated;

create function public.ask_question(p_event_uid text, p_body text, p_client_ip text default null)
returns text
language sql volatile security definer set search_path = ''
as $$ select private.ask_question_inner(p_event_uid, p_body, case when private.proxy_ok() then p_client_ip else 'unproven' end) $$;
revoke all on function public.ask_question(text, text, text) from public;
grant execute on function public.ask_question(text, text, text) to anon, authenticated;

-- The event's question page: the event, and the questions its organizer has answered. A private
-- calendar's event gives no title or calendar name to someone who only has the link.
create function public.event_questions_page(p_event_uid text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'event', jsonb_build_object(
      'title', case when f.visibility in ('public', 'unlisted') then e.title end,
      'calendar', case when f.visibility in ('public', 'unlisted') then f.name end,
      'starts_at', e.starts_at, 'ends_at', e.ends_at, 'all_day', e.all_day, 'timezone', e.timezone),
    'answered', coalesce((
      select jsonb_agg(jsonb_build_object('question', q.body, 'answer', q.answer, 'answered_at', q.answered_at) order by q.answered_at desc)
      from (select * from public.event_questions x where x.event_id = e.id and x.status = 'answered' order by x.answered_at desc limit 50) q
    ), '[]'::jsonb))
  from public.events e join public.feeds f on f.id = e.feed_id
  where e.uid = left(p_event_uid, 200) and e.published and e.status <> 'cancelled'
    and f.hidden_at is null and f.delete_requested_at is null;
$$;
revoke all on function public.event_questions_page(text) from public;
grant execute on function public.event_questions_page(text) to anon, authenticated;

-- The organizer (or an editor) answers; the question and answer then show on the event's page.
create function public.answer_question(p_question_id uuid, p_answer text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_answer text := nullif(left(trim(coalesce(p_answer, '')), 1000), '');
  n integer;
begin
  if v_answer is null then
    return false;
  end if;
  update public.event_questions q set answer = v_answer, answered_at = now(), answered_by = (select auth.uid()), status = 'answered'
  where q.id = p_question_id and q.status in ('open', 'answered') and private.is_feed_member(q.feed_id);
  get diagnostics n = row_count;
  return n = 1;
end;
$$;
revoke all on function public.answer_question(uuid, text) from public, anon;
grant execute on function public.answer_question(uuid, text) to authenticated;

-- Hide a question: it is never shown, and an answer already given comes off the page.
create function public.hide_question(p_question_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  n integer;
begin
  update public.event_questions q set status = 'hidden', answer = null, answered_at = null
  where q.id = p_question_id and q.status <> 'hidden' and private.is_feed_member(q.feed_id);
  get diagnostics n = row_count;
  return n = 1;
end;
$$;
revoke all on function public.hide_question(uuid) from public, anon;
grant execute on function public.hide_question(uuid) to authenticated;
