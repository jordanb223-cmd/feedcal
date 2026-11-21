-- Phase 3: profile on signup, account deletion with a 14-day grace period.

-- ---------------------------------------------------------------- profile on signup
-- Display name comes from the Google profile when there is one; magic-link users start blank.
create function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), '');
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(v_name, 80))
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------- deletion requests
-- The signed-in user schedules their own deletion. Returns when it will happen.
create function public.request_account_deletion()
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
    returning deleted_at + interval '14 days' into v_at;
  return v_at;
end;
$$;

create function public.cancel_account_deletion()
returns void
language sql volatile security definer set search_path = ''
as $$
  update public.profiles set deleted_at = null where id = (select auth.uid());
$$;

revoke all on function public.request_account_deletion(), public.cancel_account_deletion() from public, anon;
grant execute on function public.request_account_deletion(), public.cancel_account_deletion() to authenticated;

-- ---------------------------------------------------------------- purge (service role only)
create function public.due_account_deletions()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select id from public.profiles
  where deleted_at is not null and deleted_at <= now() - interval '14 days'
  order by deleted_at;
$$;

-- Removes a user's personal data from Feedcal's tables. Each feed they own goes to its
-- longest-standing editor; a feed with no editor is deleted (its Vault secret goes with it).
-- The caller then deletes the auth user, which cascades the profile. Safe to run twice.
create function public.purge_account_data(p_user_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_feed record;
  v_heir uuid;
  v_transferred integer := 0;
  v_deleted integer := 0;
begin
  for v_feed in select id from public.feeds where owner_id = p_user_id for update loop
    select fe.user_id into v_heir from public.feed_editors fe
      where fe.feed_id = v_feed.id and fe.role = 'editor'
      order by fe.created_at, fe.user_id limit 1;
    if v_heir is null then
      delete from public.feeds where id = v_feed.id;
      v_deleted := v_deleted + 1;
    else
      delete from public.feed_editors where feed_id = v_feed.id and user_id = p_user_id;
      update public.feed_editors set role = 'owner' where feed_id = v_feed.id and user_id = v_heir;
      update public.feeds set owner_id = v_heir where id = v_feed.id;
      v_transferred := v_transferred + 1;
    end if;
  end loop;

  delete from public.feed_editors where user_id = p_user_id;
  update public.event_revisions set actor = 'system' where actor = 'user:' || p_user_id::text;
  update public.supporters set user_id = null where user_id = p_user_id;
  update public.profiles set display_name = null where id = p_user_id;

  return jsonb_build_object('feeds_transferred', v_transferred, 'feeds_deleted', v_deleted);
end;
$$;

revoke all on function public.due_account_deletions(), public.purge_account_data(uuid) from public, anon, authenticated;
grant execute on function public.due_account_deletions(), public.purge_account_data(uuid) to service_role;

-- Signed-in users can see their own deletion date (deleted_at) via profiles_select_own.
