-- D61: uploads. Only the server may call the functions; membership, type, size and extension are
-- checked; a ticket works once; an editor's upload counts as trusted, a removed editor's doesn't;
-- abandoned uploads are cleaned up.
begin;
select * from no_plan();
select pgmq.purge_queue('triage_message');
select pgmq.purge_queue('reconcile_message');
delete from private.upload_tickets;
\set alice '11111111-1111-4111-8111-111111111111'
\set bob '22222222-2222-4222-8222-222222222222'
\set feed 'aaaaaaaa-0000-4000-8000-000000000001'

select is(has_function_privilege('anon', 'public.upload_start(uuid, uuid, text, text, integer)', 'execute'), false, 'anon can''t start uploads directly');
select is(has_function_privilege('authenticated', 'public.upload_start(uuid, uuid, text, text, integer)', 'execute'), false, 'signed-in users go through the function');
select is(has_function_privilege('authenticated', 'public.upload_finish(uuid, uuid, integer, text)', 'execute'), false, 'nor finish them directly');
select is(has_function_privilege('authenticated', 'public.upload_ticket(uuid, uuid)', 'execute'), false, 'nor read tickets');

select is(public.upload_start(:'bob', :'feed', 'x.pdf', 'application/pdf', 100) ->> 'reason', 'not_allowed', 'only the calendar''s editors');
select is(public.upload_start(:'alice', :'feed', 'x.exe', 'application/x-msdownload', 100) ->> 'reason', 'unsupported_type', 'unknown types refused');
select is(public.upload_start(:'alice', :'feed', 'x.docx', 'application/pdf', 100) ->> 'reason', 'unsupported_type', 'the extension must match the type');
select is(public.upload_start(:'alice', :'feed', 'x.pdf', 'application/pdf', 10485761) ->> 'reason', 'too_large', 'over 10 MB refused');
select is(public.upload_start(:'alice', :'feed', E'../\x01evil.pdf', 'application/pdf', 100) ->> 'ok', 'true', 'path-like names are cleaned, not trusted');
select ok((select bool_and(path ~ ('^' || :'feed' || '/upload-[0-9a-f-]{36}/file\.pdf$') and filename = '..evil.pdf') from private.upload_tickets), 'the storage spot is chosen by the server');

select (public.upload_start(:'alice', :'feed', 'pgTAP upload 027.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 5000) ->> 'ticket') as t \gset
select is(public.upload_finish(:'bob', :'t'::uuid, 5000, repeat('a', 64)) ->> 'reason', 'unknown_ticket', 'someone else''s ticket doesn''t work');
select is(public.upload_finish(:'alice', :'t'::uuid, 5000, repeat('a', 64)) ->> 'ok', 'true', 'the editor finishes it');
select is(public.upload_finish(:'alice', :'t'::uuid, 5000, repeat('a', 64)) ->> 'reason', 'already_used', 'a ticket works once');
select is((select status || '|' || (uploaded_by = :'alice') from public.messages where original_subject = 'pgTAP upload 027.docx'), 'parsed|true', 'a parsed message by Alice');
select is((select count(*)::int from pgmq.q_triage_message), 1, 'queued for reading');

-- Trust: an editor's upload publishes like a trusted sender's; a removed editor's waits.
create function pg_temp.cand(p_msg uuid, p_title text) returns void language plpgsql as $$
begin
  insert into public.event_candidates (message_id, feed_id, title, starts_at, all_day, timezone, change_kind, confidence, evidence_quote, source_kind, review_reasons, date_confirmed)
  values (p_msg, 'aaaaaaaa-0000-4000-8000-000000000001', p_title, now() + interval '9 days', true, 'America/Los_Angeles', 'new', 0.95, 'q ' || p_title, 'page', '{}', true);
  perform pgmq.send('reconcile_message', jsonb_build_object('message_id', p_msg));
  perform public.reconcile_pending(10);
end $$;
select pg_temp.cand((select id from public.messages where original_subject = 'pgTAP upload 027.docx'), 'Uploaded concert');
select is((select published from public.events where title = 'Uploaded concert'), true, 'an editor''s upload is trusted');
insert into public.messages (id, feed_id, uploaded_by, status, original_subject) values ('99999999-0000-4000-8000-0000000000f1', :'feed', :'bob', 'parsed', 'Bob upload');
select pg_temp.cand('99999999-0000-4000-8000-0000000000f1', 'Not an editor event');
select is((select published from public.events where title = 'Not an editor event'), false, 'an upload by someone who isn''t an editor waits for review');

-- Abandoned uploads go to the storage trash.
insert into private.upload_tickets (feed_id, user_id, filename, mime, declared_bytes, path, expires_at)
values (:'feed', :'alice', 'old.pdf', 'application/pdf', 10, :'feed' || '/upload-00000000-0000-4000-8000-000000000999/file.pdf', now() - interval '2 hours');
select ok(private.expire_upload_tickets() >= 1, 'expired tickets are cleaned up');
select is((select count(*)::int from private.storage_trash where path like '%000000000999/file.pdf'), 1, 'their file is queued for deletion');
select is((select count(*)::int from private.upload_tickets where path like '%000000000999%'), 0, 'and the ticket is gone');

select * from finish();
rollback;
