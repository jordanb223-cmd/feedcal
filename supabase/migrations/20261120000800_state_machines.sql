-- Make the app's implicit state machines explicit (docs/STATE-MACHINES.md, D24).
-- The database is the single source of truth: these tables define every legal move, one trigger
-- enforces them on UPDATE, and state_machines() exposes them. `npm run db:states` generates the
-- TypeScript copy and the diagram doc from it; CI fails if they're stale.
-- Inserts are not restricted (a row may start in any valid state), so nothing existing breaks.

create table private.state_machines (
  machine text primary key,
  table_name text not null,
  column_name text not null,
  description text not null
);

create table private.state_transitions (
  machine text not null references private.state_machines (machine) on delete cascade,
  from_state text not null,
  to_state text not null,
  description text not null,
  primary key (machine, from_state, to_state),
  check (from_state <> to_state)
);

alter table private.state_machines enable row level security;
alter table private.state_transitions enable row level security;
revoke all on table private.state_machines, private.state_transitions from public, anon, authenticated;

insert into private.state_machines (machine, table_name, column_name, description) values
  ('event_status', 'events', 'status', 'Whether an event is happening. Cancelled events stay in feeds for 30 days as STATUS:CANCELLED so calendars remove them.'),
  ('message_status', 'messages', 'status', 'A forwarded email moving through intake: parse, extract events, then review.'),
  ('attachment_status', 'attachments', 'status', 'An attachment''s text: from the PDF text layer, or a vision transcription, or skipped.'),
  ('report_status', 'reports', 'status', 'A subscriber''s "Report a problem" handled by the feed''s owners and editors.');

insert into private.state_transitions (machine, from_state, to_state, description) values
  ('event_status', 'tentative', 'confirmed', 'The organizer or a later email confirms it'),
  ('event_status', 'confirmed', 'tentative', 'A later email makes it uncertain again'),
  ('event_status', 'tentative', 'cancelled', 'Cancelled before it was confirmed'),
  ('event_status', 'confirmed', 'cancelled', 'Cancelled'),
  ('event_status', 'cancelled', 'confirmed', 'Restored'),
  ('event_status', 'cancelled', 'tentative', 'Restored, still uncertain'),

  ('message_status', 'received', 'parsed', 'MIME parsed and cleaned (Phase 7)'),
  ('message_status', 'received', 'ignored', 'Not from a trusted sender, or a duplicate'),
  ('message_status', 'received', 'failed', 'Could not be parsed'),
  ('message_status', 'parsed', 'extracted', 'Events extracted (Phase 9)'),
  ('message_status', 'parsed', 'needs_review', 'Extraction unsure; an owner must look'),
  ('message_status', 'parsed', 'ignored', 'No dates in it'),
  ('message_status', 'parsed', 'failed', 'Extraction failed after retries'),
  ('message_status', 'extracted', 'needs_review', 'An extracted event needs an owner''s decision'),
  ('message_status', 'needs_review', 'extracted', 'The owner approved the events'),
  ('message_status', 'needs_review', 'ignored', 'The owner dismissed it'),
  ('message_status', 'failed', 'received', 'Retry from the start'),
  ('message_status', 'ignored', 'received', 'The owner asked to process it after all'),

  ('attachment_status', 'pending', 'text_layer', 'The PDF has a usable text layer'),
  ('attachment_status', 'pending', 'transcribed', 'A vision model transcribed it (images, scans)'),
  ('attachment_status', 'pending', 'skipped', 'Not likely to hold the schedule (cheapest-first triage)'),
  ('attachment_status', 'pending', 'failed', 'Could not be read'),
  ('attachment_status', 'text_layer', 'transcribed', 'The text layer was empty or garbled; transcribed instead'),
  ('attachment_status', 'skipped', 'pending', 'The owner said "this one has the schedule"'),
  ('attachment_status', 'failed', 'pending', 'Retry'),

  ('report_status', 'open', 'resolved', 'Fixed'),
  ('report_status', 'open', 'dismissed', 'Not a problem'),
  ('report_status', 'resolved', 'open', 'Reopened'),
  ('report_status', 'dismissed', 'open', 'Reopened');

-- One trigger function for every machine. TG_ARGV[0] is the machine name.
-- The error names the allowed moves, so a person or an agent hitting it knows what to do.
create function private.enforce_transition()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_machine text := tg_argv[0];
  v_column text;
  v_from text;
  v_to text;
  v_allowed text;
begin
  select column_name into v_column from private.state_machines where machine = v_machine;
  v_from := to_jsonb(old) ->> v_column;
  v_to := to_jsonb(new) ->> v_column;
  if v_from is not distinct from v_to then
    return new;
  end if;
  if exists (select 1 from private.state_transitions t
             where t.machine = v_machine and t.from_state = v_from and t.to_state = v_to) then
    return new;
  end if;
  select string_agg(to_state, ', ' order by to_state) into v_allowed
    from private.state_transitions where machine = v_machine and from_state = v_from;
  raise exception '% cannot move from "%" to "%". Allowed from "%": %.',
      v_machine, v_from, v_to, v_from, coalesce(v_allowed, 'nothing (final state)')
    using errcode = '23514', hint = 'See docs/STATE-MACHINES.md or call public.state_machines().';
end;
$$;
revoke all on function private.enforce_transition() from public;

create trigger events_status_transition before update of status on public.events
  for each row execute function private.enforce_transition('event_status');
create trigger messages_status_transition before update of status on public.messages
  for each row execute function private.enforce_transition('message_status');
create trigger attachments_status_transition before update of status on public.attachments
  for each row execute function private.enforce_transition('attachment_status');
create trigger reports_status_transition before update of status on public.reports
  for each row execute function private.enforce_transition('report_status');

-- Every legal move, for code generation, the docs and agents. Contains no user data.
create function public.state_machines()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_object_agg(m.machine, jsonb_build_object(
    'table', m.table_name,
    'column', m.column_name,
    'description', m.description,
    'transitions', (select coalesce(jsonb_agg(jsonb_build_object('from', t.from_state, 'to', t.to_state, 'description', t.description)
                     order by t.from_state, t.to_state), '[]'::jsonb)
                    from private.state_transitions t where t.machine = m.machine)
  ) order by m.machine), '{}'::jsonb)
  from private.state_machines m;
$$;
revoke all on function public.state_machines() from public;
grant execute on function public.state_machines() to anon, authenticated, service_role;

-- ---------------------------------------------------------------- SEQUENCE (RFC 5545)
-- Calendar apps use SEQUENCE to decide whether an edit is newer than what they have. Before this,
-- nothing raised it, so an organizer's edit could be ignored by subscribers' calendars.
-- Any change a subscriber can see raises it by one, unless the caller already raised it.
create function private.events_bump_sequence()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (new.title, new.description, new.location, new.starts_at, new.ends_at, new.all_day,
      new.timezone, new.rrule, new.status)
     is distinct from
     (old.title, old.description, old.location, old.starts_at, old.ends_at, old.all_day,
      old.timezone, old.rrule, old.status)
     and new.sequence <= old.sequence then
    new.sequence := old.sequence + 1;
  end if;
  return new;
end;
$$;
revoke all on function private.events_bump_sequence() from public;
create trigger events_bump_sequence before update on public.events
  for each row execute function private.events_bump_sequence();

-- ---------------------------------------------------------------- account deletion
-- The grace period, defined once. Everything else reads it.
create function private.deletion_grace()
returns interval
language sql immutable set search_path = ''
as $$ select interval '14 days' $$;
revoke all on function private.deletion_grace() from public;
grant execute on function private.deletion_grace() to authenticated, service_role;

create or replace function public.request_account_deletion()
returns timestamptz
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if (select auth.uid()) is null then
    raise exception 'Please sign in first.' using errcode = '42501';
  end if;
  update public.profiles set deleted_at = coalesce(deleted_at, now())
    where id = (select auth.uid())
    returning deleted_at + private.deletion_grace() into v_at;
  return v_at;
end;
$$;

create or replace function public.due_account_deletions()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select id from public.profiles
  where deleted_at is not null and deleted_at <= now() - private.deletion_grace()
  order by deleted_at;
$$;

-- The signed-in user's account state: active, or scheduled with the date it will be deleted.
-- ("due" and "purged" are only seen by the purge job; a purged user can't call this.)
create function public.account_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'state', case when p.deleted_at is null then 'active' else 'scheduled_for_deletion' end,
    'deletion_requested_at', p.deleted_at,
    'deletes_on', p.deleted_at + private.deletion_grace(),
    'grace_days', extract(day from private.deletion_grace())::int
  )
  from public.profiles p where p.id = (select auth.uid());
$$;
revoke all on function public.account_status() from public, anon;
grant execute on function public.account_status() to authenticated;
