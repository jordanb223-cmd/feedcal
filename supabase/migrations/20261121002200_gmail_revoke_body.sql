-- D51: Gmail disconnect no longer revokes from SQL. pg_net can only send JSON, so the token went in
-- the URL; the web app now calls the gmail-revoke Edge Function first (form body), then this.
create or replace function public.gmail_disconnect(p_feed_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c private.gmail_connections;
  v_deleted integer;
begin
  perform private.assert_feed_owner(p_feed_id);
  select * into c from private.gmail_connections where feed_id = p_feed_id for update;
  if c.feed_id is null then
    return jsonb_build_object('disconnected', false);
  end if;
  with gone as (
    delete from public.messages m using private.gmail_messages g
    where g.feed_id = p_feed_id and g.message_id = m.id returning 1)
  select count(*) into v_deleted from gone;
  delete from private.gmail_messages where feed_id = p_feed_id;
  delete from private.gmail_connections where feed_id = p_feed_id;  -- the trigger deletes the Vault token
  delete from private.gmail_oauth_states where feed_id = p_feed_id;
  return jsonb_build_object('disconnected', true, 'messages_deleted', v_deleted);
end;
$$;
