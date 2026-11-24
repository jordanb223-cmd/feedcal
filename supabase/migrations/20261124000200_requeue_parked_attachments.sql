-- D71: photos, scans and image-only PDFs that could not be read yet are picked up again.
-- Two cases park a file as "pending":
--   needs_vision_not_configured  it arrived before image reading was switched on;
--   daily_vision_limit           the owner's daily page limit (or the monthly budget) was used up.
-- Nothing sent these back through, so they waited for ever. triage-attachments now calls this at
-- the start of each run, but only while image reading is switched on. Each email is retried once
-- for the first case (its reason changes when it is read), and once a day for the second.
create function public.requeue_parked_attachments(p_limit integer default 5)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select m.id from public.messages m
    where m.received_at > now() - interval '30 days'
      and exists (
        select 1 from public.attachments a
        where a.message_id = m.id and a.status = 'pending'
          and (a.triage ->> 'reason' = 'needs_vision_not_configured'
               or (a.triage ->> 'reason' = 'daily_vision_limit' and a.triaged_at < date_trunc('day', now()))))
      and not exists (select 1 from pgmq.q_triage_message q where q.message ->> 'message_id' = m.id::text)
    order by m.received_at desc
    limit least(greatest(coalesce(p_limit, 5), 1), 50)
  loop
    perform pgmq.send('triage_message', jsonb_build_object('message_id', v_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.requeue_parked_attachments(integer) from public, anon, authenticated;
grant execute on function public.requeue_parked_attachments(integer) to service_role;
