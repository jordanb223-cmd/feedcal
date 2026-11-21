-- Phase 11: the organizer's review screen (D32). Every action is a member-checked RPC that
-- writes a revision (actor user:<id>), and destructive ones can be undone for 10 seconds.

alter table public.event_candidates
  add column reject_reason text check (reject_reason is null or reject_reason in ('not_an_event', 'wrong_date', 'wrong_time', 'wrong_details', 'duplicate', 'other')),
  add column reject_note text check (reject_note is null or char_length(reject_note) <= 500),
  add column decided_by uuid references public.profiles (id) on delete set null;

alter table public.feeds add column delete_requested_at timestamptz;

-- Undo log: what a destructive action changed, restorable for 10 seconds.
create table public.undo_log (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.feeds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('reject_candidate', 'discard_draft', 'cancel_event', 'delete_feed')),
  target uuid not null,
  before jsonb not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
alter table public.undo_log enable row level security;
revoke all on table public.undo_log from anon, authenticated;
grant select on table public.undo_log to authenticated;
create policy undo_log_own_select on public.undo_log for select to authenticated using (user_id = (select auth.uid()));

create function private.require_member(p_feed_id uuid)
returns uuid
language plpgsql stable set search_path = ''
as $$
begin
  if p_feed_id is null or not private.is_feed_member(p_feed_id) then
    raise exception 'Not found.' using errcode = 'P0002';
  end if;
  return (select auth.uid());
end;
$$;
revoke all on function private.require_member(uuid) from public;
grant execute on function private.require_member(uuid) to authenticated;

create function private.user_revise(p_event_id uuid, p_cause text, p_diff jsonb)
returns void
language sql volatile set search_path = ''
as $$
  insert into public.event_revisions (event_id, sequence, diff, cause, actor)
  select p_event_id, e.sequence, p_diff, p_cause, 'user:' || (select auth.uid()) from public.events e where e.id = p_event_id
$$;
revoke all on function private.user_revise(uuid, text, jsonb) from public;

-- Local "YYYY-MM-DD" + optional "HH:MM" in a zone → timestamptz.
create function private.local_ts(p_date text, p_time text, p_tz text)
returns timestamptz
language sql stable set search_path = ''
as $$ select ((p_date || ' ' || coalesce(nullif(p_time, ''), '12:00'))::timestamp at time zone p_tz) $$;
revoke all on function private.local_ts(text, text, text) from public;
grant execute on function private.local_ts(text, text, text) to authenticated;

-- ---------------------------------------------------------------- review actions
-- Approve a candidate waiting for review, optionally with the owner's edits
-- ({title, date, time, location}). Applies what the reconciler held back.
create function public.approve_candidate(p_candidate_id uuid, p_edits jsonb default null)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c public.event_candidates%rowtype;
  e public.events%rowtype;
  v_start timestamptz;
  v_title text;
  v_location text;
  v_event uuid;
begin
  select * into c from public.event_candidates where id = p_candidate_id for update;
  perform private.require_member(c.feed_id);
  if c.state <> 'needs_review' then
    raise exception 'This item was already decided.' using errcode = 'P0002';
  end if;
  v_title := coalesce(nullif(trim(p_edits ->> 'title'), ''), c.title);
  v_location := case when p_edits ? 'location' then nullif(trim(p_edits ->> 'location'), '') else c.location end;
  v_start := case when p_edits ? 'date' then private.local_ts(p_edits ->> 'date', p_edits ->> 'time', c.timezone) else c.starts_at end;
  if c.event_id is not null then select * into e from public.events where id = c.event_id for update; end if;

  if c.outcome in ('cancel', 'unmatched_change') and c.change_kind = 'cancelled' and e.id is not null then
    update public.events set status = 'cancelled', updated_at = now() where id = e.id;
    perform private.user_revise(e.id, 'cancelled', jsonb_build_object('status', jsonb_build_array(e.status, 'cancelled'), 'evidence_quote', c.evidence_quote));
    v_event := e.id;
  elsif c.outcome = 'exdate' and e.id is not null then
    update public.events set exdates = exdates || c.starts_at, updated_at = now() where id = e.id and not (c.starts_at = any(exdates));
    perform private.user_revise(e.id, 'cancelled', jsonb_build_object('exdate', c.starts_at, 'evidence_quote', c.evidence_quote));
    v_event := e.id;
  elsif c.outcome in ('update', 'conflict') and e.id is not null then
    update public.events set title = v_title, starts_at = v_start,
      ends_at = case when c.ends_at is null then null else v_start + (c.ends_at - c.starts_at) end,
      location = coalesce(v_location, location), status = 'confirmed', published = true,
      evidence_quote = c.evidence_quote, source_message_id = c.message_id, updated_at = now()
      where id = e.id;
    perform private.user_revise(e.id, 'matched_update', jsonb_build_object('starts_at', jsonb_build_array(e.starts_at, v_start), 'title', jsonb_build_array(e.title, v_title), 'evidence_quote', c.evidence_quote));
    v_event := e.id;
  else
    insert into public.events (feed_id, title, description, location, starts_at, ends_at, all_day, timezone, rrule, status, confidence,
      source_message_id, evidence_quote, published, source_thread)
    values (c.feed_id, v_title, c.description, v_location, v_start,
      case when c.ends_at is null then null else v_start + (c.ends_at - c.starts_at) end, c.all_day, c.timezone, c.rrule, 'confirmed',
      c.confidence, c.message_id, c.evidence_quote, true, null)
    returning id into v_event;
    perform private.user_revise(v_event, 'extracted', jsonb_build_object('approved_candidate', c.id));
  end if;
  update public.event_candidates set state = 'applied', event_id = v_event, decided_at = now(), decided_by = (select auth.uid()) where id = c.id;
  return v_event;
end;
$$;

-- Reject, with a reason that goes into the extraction feedback (the evaluation set grows from it).
create function public.reject_candidate(p_candidate_id uuid, p_reason text, p_note text default null)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c public.event_candidates%rowtype;
  v_undo uuid;
begin
  select * into c from public.event_candidates where id = p_candidate_id for update;
  perform private.require_member(c.feed_id);
  if c.state <> 'needs_review' then
    raise exception 'This item was already decided.' using errcode = 'P0002';
  end if;
  update public.event_candidates set state = 'rejected', reject_reason = coalesce(p_reason, 'other'), reject_note = left(p_note, 500),
    decided_at = now(), decided_by = (select auth.uid()) where id = c.id;
  insert into public.undo_log (feed_id, user_id, kind, target, before)
  values (c.feed_id, (select auth.uid()), 'reject_candidate', c.id, jsonb_build_object('state', 'needs_review')) returning id into v_undo;
  return v_undo;
end;
$$;

-- Drafts (events from untrusted senders or unsure extractions) are published or discarded.
create function public.publish_draft(p_event_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e public.events%rowtype;
begin
  select * into e from public.events where id = p_event_id for update;
  perform private.require_member(e.feed_id);
  update public.events set published = true, status = 'confirmed', updated_at = now() where id = e.id and not published;
  perform private.user_revise(e.id, 'restored', jsonb_build_object('published', jsonb_build_array(false, true)));
  return true;
end;
$$;

create function public.discard_draft(p_event_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_undo uuid;
begin
  select * into e from public.events where id = p_event_id for update;
  perform private.require_member(e.feed_id);
  if e.published then
    raise exception 'Only drafts can be discarded; cancel a published event instead.' using errcode = 'P0001';
  end if;
  -- Never deleted: a discarded draft is a cancelled, unpublished event no calendar or page shows.
  update public.events set status = 'cancelled', updated_at = now() where id = e.id;
  insert into public.undo_log (feed_id, user_id, kind, target, before)
  values (e.feed_id, (select auth.uid()), 'discard_draft', e.id, jsonb_build_object('status', e.status)) returning id into v_undo;
  return v_undo;
end;
$$;

-- "Approve all Sure": confident items without warnings. Conflicts and possible injections never.
create function public.approve_all_sure(p_feed_id uuid)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  perform private.require_member(p_feed_id);
  for v_id in select id from public.event_candidates
              where feed_id = p_feed_id and state = 'needs_review' and confidence >= 0.85
                and outcome is distinct from 'conflict' and not ('possible_injection' = any(review_reasons))
                and not ('low_confidence' = any(review_reasons)) loop
    perform public.approve_candidate(v_id);
    v_count := v_count + 1;
  end loop;
  for v_id in select id from public.events
              where feed_id = p_feed_id and not published and status = 'tentative' and coalesce(confidence, 0) >= 0.85 loop
    perform public.publish_draft(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- manual events
-- Create (p_event_id null) or edit. Fields: title, date, time, end_date, end_time, all_day,
-- location, description. Times are local to the feed's timezone.
create function public.save_event(p_feed_id uuid, p_event_id uuid, p_fields jsonb)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_tz text;
  v_all_day boolean := coalesce((p_fields ->> 'all_day')::boolean, false);
  v_start timestamptz;
  v_end timestamptz;
  e public.events%rowtype;
  v_id uuid;
begin
  perform private.require_member(p_feed_id);
  select timezone into v_tz from public.feeds where id = p_feed_id;
  if coalesce(trim(p_fields ->> 'title'), '') = '' or coalesce(p_fields ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Please give the event a title and a date.' using errcode = '22023';
  end if;
  if not v_all_day and coalesce(p_fields ->> 'time', '') !~ '^\d{2}:\d{2}$' then
    raise exception 'Please give a start time, or tick "All day".' using errcode = '22023';
  end if;
  v_start := private.local_ts(p_fields ->> 'date', case when v_all_day then '12:00' else p_fields ->> 'time' end, v_tz);
  v_end := case when coalesce(p_fields ->> 'end_date', '') ~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p_fields ->> 'end_time', '') ~ '^\d{2}:\d{2}$'
            then private.local_ts(coalesce(nullif(p_fields ->> 'end_date', ''), p_fields ->> 'date'),
                                  case when v_all_day then '12:00' else coalesce(nullif(p_fields ->> 'end_time', ''), p_fields ->> 'time') end, v_tz) end;
  if v_end is not null and v_end < v_start then
    raise exception 'The end is before the start.' using errcode = '22023';
  end if;
  if p_event_id is null then
    insert into public.events (feed_id, title, description, location, starts_at, ends_at, all_day, timezone, status, published)
    values (p_feed_id, left(trim(p_fields ->> 'title'), 300), nullif(left(p_fields ->> 'description', 8000), ''),
            nullif(left(trim(p_fields ->> 'location'), 500), ''), v_start, v_end, v_all_day, v_tz, 'confirmed', true)
    returning id into v_id;
    perform private.user_revise(v_id, 'manual_edit', jsonb_build_object('created', true));
    return v_id;
  end if;
  select * into e from public.events where id = p_event_id and feed_id = p_feed_id for update;
  if not found then raise exception 'Not found.' using errcode = 'P0002'; end if;
  update public.events set title = left(trim(p_fields ->> 'title'), 300), description = nullif(left(p_fields ->> 'description', 8000), ''),
    location = nullif(left(trim(p_fields ->> 'location'), 500), ''), starts_at = v_start, ends_at = v_end, all_day = v_all_day,
    published = true, status = case when status = 'tentative' then 'confirmed' else status end, updated_at = now()
    where id = e.id;
  perform private.user_revise(e.id, 'manual_edit', jsonb_build_object(
    'title', jsonb_build_array(e.title, left(trim(p_fields ->> 'title'), 300)), 'starts_at', jsonb_build_array(e.starts_at, v_start),
    'location', jsonb_build_array(e.location, nullif(trim(p_fields ->> 'location'), ''))));
  return e.id;
end;
$$;

create function public.cancel_event(p_event_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e public.events%rowtype;
  v_undo uuid;
begin
  select * into e from public.events where id = p_event_id for update;
  perform private.require_member(e.feed_id);
  update public.events set status = 'cancelled', updated_at = now() where id = e.id and status <> 'cancelled';
  perform private.user_revise(e.id, 'cancelled', jsonb_build_object('status', jsonb_build_array(e.status, 'cancelled')));
  insert into public.undo_log (feed_id, user_id, kind, target, before)
  values (e.feed_id, (select auth.uid()), 'cancel_event', e.id, jsonb_build_object('status', e.status)) returning id into v_undo;
  return v_undo;
end;
$$;

-- ---------------------------------------------------------------- settings
create function public.add_editor(p_feed_id uuid, p_email text)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid;
begin
  if private.feed_role(p_feed_id) is distinct from 'owner' then
    raise exception 'Only the owner can add editors.' using errcode = '42501';
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    return 'not_found'; -- they need to sign in to Feedcal once first
  end if;
  insert into public.feed_editors (feed_id, user_id, role) values (p_feed_id, v_user, 'editor') on conflict do nothing;
  return 'added';
end;
$$;

create function public.clear_attachment_rule(p_source_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.require_member((select feed_id from public.sources where id = p_source_id));
  update public.sources set attachment_rule = null where id = p_source_id;
  return true;
end;
$$;

-- Deleting a feed waits 10 seconds (undo), then the purge job removes it. Hidden meanwhile.
create function public.request_feed_deletion(p_feed_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_undo uuid;
begin
  if private.feed_role(p_feed_id) is distinct from 'owner' then
    raise exception 'Only the owner can delete a feed.' using errcode = '42501';
  end if;
  -- Stop serving it at once: private (no page) and an unguessable link hash (no calendar).
  -- The old values are kept so Undo can put them back.
  insert into public.undo_log (feed_id, user_id, kind, target, before)
  select p_feed_id, (select auth.uid()), 'delete_feed', p_feed_id,
         jsonb_build_object('visibility', visibility, 'slug', slug, 'feed_token_hash', encode(feed_token_hash, 'hex'))
  from public.feeds where id = p_feed_id
  returning id into v_undo;
  update public.feeds set delete_requested_at = now(), visibility = 'private',
    feed_token_hash = extensions.digest(extensions.gen_random_bytes(32), 'sha256')
  where id = p_feed_id;
  return v_undo;
end;
$$;

create function public.undo(p_undo_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  u public.undo_log%rowtype;
begin
  select * into u from public.undo_log where id = p_undo_id and user_id = (select auth.uid()) for update;
  if not found or u.undone_at is not null then
    raise exception 'Nothing to undo.' using errcode = 'P0002';
  end if;
  if u.created_at < now() - interval '10 seconds' then
    raise exception 'Too late to undo.' using errcode = 'P0001';
  end if;
  case u.kind
    when 'reject_candidate' then
      update public.event_candidates set state = 'needs_review', reject_reason = null, reject_note = null, decided_at = null, decided_by = null where id = u.target;
    when 'discard_draft', 'cancel_event' then
      update public.events set status = u.before ->> 'status', updated_at = now() where id = u.target;
    when 'delete_feed' then
      -- Put back the exact slug: without this flag the unlisted-slug trigger would re-randomise it.
      perform set_config('feedcal.restoring_feed', 'on', true);
      update public.feeds set delete_requested_at = null, visibility = u.before ->> 'visibility', slug = u.before ->> 'slug',
        feed_token_hash = decode(u.before ->> 'feed_token_hash', 'hex') where id = u.target;
      perform set_config('feedcal.restoring_feed', 'off', true);
  end case;
  update public.undo_log set undone_at = now() where id = u.id;
  return u.kind;
end;
$$;

create function private.purge_deleted_feeds()
returns integer
language plpgsql volatile set search_path = ''
as $$
declare
  v integer;
begin
  delete from public.feeds where delete_requested_at < now() - interval '10 seconds';
  get diagnostics v = row_count;
  delete from public.undo_log where created_at < now() - interval '1 day';
  return v;
end;
$$;
revoke all on function private.purge_deleted_feeds() from public;
select cron.schedule('feedcal-purge-deleted-feeds', '* * * * *', $$ select private.purge_deleted_feeds() $$);

revoke all on function public.approve_candidate(uuid, jsonb), public.reject_candidate(uuid, text, text), public.publish_draft(uuid),
  public.discard_draft(uuid), public.approve_all_sure(uuid), public.save_event(uuid, uuid, jsonb), public.cancel_event(uuid),
  public.add_editor(uuid, text), public.clear_attachment_rule(uuid), public.request_feed_deletion(uuid), public.undo(uuid) from public, anon;
grant execute on function public.approve_candidate(uuid, jsonb), public.reject_candidate(uuid, text, text), public.publish_draft(uuid),
  public.discard_draft(uuid), public.approve_all_sure(uuid), public.save_event(uuid, uuid, jsonb), public.cancel_event(uuid),
  public.add_editor(uuid, text), public.clear_attachment_rule(uuid), public.request_feed_deletion(uuid), public.undo(uuid) to authenticated;


-- The unlisted-slug trigger, with one exception: undoing a feed deletion restores the old slug.
create or replace function private.feeds_unlisted_slug()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(current_setting('feedcal.restoring_feed', true), 'off') = 'on' then
    return new;
  end if;
  if new.visibility = 'unlisted'
     and (tg_op = 'INSERT' or old.visibility <> 'unlisted' or new.slug <> old.slug) then
    new.slug := left(new.slug, 71) || '-' || private.random_suffix();
  end if;
  return new;
end;
$$;

-- Members see whether a feed is waiting to be deleted (the dashboard hides it).
grant select (delete_requested_at) on table public.feeds to authenticated;

-- Bug fix (found by the Phase 11 end-to-end test): since Phase 6 a signed-in user couldn't create a
-- feed, because the trigger that gives it an intake address called a private function the user
-- can't execute. The trigger runs as its owner now; it only ever generates the address.
alter function private.feeds_set_intake_address() security definer;
-- Same class of bug, found by auditing every trigger on tables users write to directly:
-- these read or write private tables/functions, so they must run as their owner.
alter function private.enforce_transition() security definer;   -- reads the private transition rules
alter function private.messages_trash_raw() security definer;   -- members may delete messages
alter function private.attachments_trash_file() security definer;
