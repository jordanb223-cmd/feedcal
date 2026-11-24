-- Phase 6 intake: addresses, tickets, dedupe, allowlist, quarantine, decisions, expiry.
begin;
select * from no_plan();

-- Start from the seed, whatever earlier local runs (e.g. integration tests) left behind.
-- All of this is rolled back at the end.
delete from public.forwarding_confirmations;
delete from public.messages where id not in ('dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002');
delete from public.sources where id <> 'cccccccc-0000-4000-8000-000000000001';
delete from private.ingest_tickets;
delete from private.storage_trash;
select pgmq.purge_queue('process_message');

-- Helpers: start + commit as the service role would.
create function pg_temp.start(p_local text, p_bytes bigint default 1000) returns jsonb
  language sql as $$ select public.ingest_start(p_local, p_bytes) $$;
create function pg_temp.commit(p_start jsonb, p_msgid text, p_sender text, p_body text,
                               p_attachments int default 0, p_dmarc text default 'pass', p_gmail jsonb default null)
returns jsonb language sql as $$
  select public.ingest_commit((p_start ->> 'ticket')::uuid, p_start ->> 'path', 1000, p_msgid, p_sender, 'Subject',
                              extensions.digest(p_body, 'sha256'), p_attachments, 'pass', 'pass', p_dmarc, p_gmail)
$$;
create function pg_temp.queued() returns bigint language sql as $$ select count(*) from pgmq.q_process_message $$;

-- ---------------------------------------------------------------- addresses
select is((select count(*)::int from public.feeds where intake_address !~ '^feed-[a-z2-7]{20}$'), 0,
  'every feed has an intake address in the right format');
insert into public.feeds (owner_id, name, slug) values ('11111111-1111-4111-8111-111111111111', 'New', 'new-intake-feed');
select matches((select intake_address from public.feeds where slug = 'new-intake-feed'), '^feed-[a-z2-7]{20}$',
  'a new feed gets an address automatically');
select isnt((select intake_address from public.feeds where slug = 'new-intake-feed'),
            (select intake_address from public.feeds where slug = 'sutterville-kindergarten'), 'addresses differ');

-- ---------------------------------------------------------------- who can call
set local role anon;
select throws_ok($$ select public.ingest_start('feed-aliceschoolfeed23456', 10) $$, '42501', null, 'anon cannot start an ingest');
reset role;
set local role authenticated;
select throws_ok($$ select public.ingest_commit(gen_random_uuid(), 'x', 1, null, null, null, null, 0) $$, '42501', null,
  'a signed-in user cannot commit an ingest');
reset role;

-- ---------------------------------------------------------------- start
select is(pg_temp.start('feed-zzzzzzzzzzzzzzzzzzzz') ->> 'reject', 'unknown_address', 'unknown address is rejected');
select is(pg_temp.start('postmaster') ->> 'reject', 'unknown_address', 'malformed address is rejected');
select is(pg_temp.start('feed-aliceschoolfeed23456', 21 * 1024 * 1024) ->> 'reject', 'too_large', 'over 20 MB is rejected');
select ok((pg_temp.start('FEED-ALICESCHOOLFEED23456') ->> 'ok')::boolean, 'addresses are case-insensitive');

-- ---------------------------------------------------------------- trusted sender: queued, idempotent
create temp table s1 as select pg_temp.start('feed-aliceschoolfeed23456') as j;
select is(pg_temp.queued(), 0::bigint, 'queue starts empty');
select is((select pg_temp.commit(j, '<m1@school.example.test>', 'Office@School.example.test', 'body one') from s1) ->> 'outcome',
  'queued', 'mail from a trusted sender is queued');
select is(pg_temp.queued(), 1::bigint, 'one job on the process_message queue');
select is((select pg_temp.commit(j, '<m1@school.example.test>', 'office@school.example.test', 'body one') from s1) ->> 'outcome',
  'queued', 'committing the same ticket twice returns the first result');
select is(pg_temp.queued(), 1::bigint, '...and does not queue it twice');
select is((select public.ingest_commit((j ->> 'ticket')::uuid, 'wrong/path.eml', 1, null, null, null, null, 0) from s1) ->> 'reject',
  'unknown_ticket', 'a ticket only commits its own path');

-- ---------------------------------------------------------------- duplicates
select is(pg_temp.commit(pg_temp.start('feed-aliceschoolfeed23456'), '<m1@school.example.test>', 'office@school.example.test', 'different body') ->> 'outcome',
  'duplicate', 'same Message-ID is a duplicate');
select is(pg_temp.commit(pg_temp.start('feed-aliceschoolfeed23456'), '<other@school.example.test>', 'office@school.example.test', 'body one') ->> 'outcome',
  'duplicate', 'same body is a duplicate');
select ok((select count(*) from private.storage_trash) >= 2, 'duplicates'' raw files are queued for deletion');

-- ---------------------------------------------------------------- quarantine
create temp table q as
  select pg_temp.commit(pg_temp.start('feed-aliceschoolfeed23456'), '<n1@pta.example.test>', 'chair@pta.example.test', 'pta 1') as j;
select is((select j ->> 'outcome' from q), 'quarantined', 'mail from a new sender waits');
select is((select j ->> 'reason' from q), 'new_sender', '...because the sender is new');
select is((select trusted from public.sources where sender_email = 'chair@pta.example.test'), false, 'the sender is recorded, untrusted');
select is(pg_temp.commit(pg_temp.start('feed-aliceschoolfeed23456'), '<f1@school.example.test>', 'office@school.example.test', 'spoof', 0, 'fail') ->> 'reason',
  'failed_authentication', 'a trusted sender that fails DMARC is quarantined');
select is(pg_temp.queued(), 1::bigint, 'nothing quarantined is queued');

-- ---------------------------------------------------------------- limits
select is(pg_temp.commit(pg_temp.start('feed-aliceschoolfeed23456'), '<a1@school.example.test>', 'office@school.example.test', 'att', 21) ->> 'reject',
  'too_many_attachments', 'more than 20 attachments is rejected (D75; it was 10)');

-- ---------------------------------------------------------------- Gmail confirmation
select is(pg_temp.commit(pg_temp.start('feed-aliceschoolfeed23456'), '<g1@google.com>', 'forwarding-noreply@google.com', 'gmail',
          0, 'pass', '{"code":"957493560","url":"https://mail-settings.google.com/mail/vf-abc","requested_by":"parent@gmail.example"}') ->> 'outcome',
  'gmail_confirmation', 'a Gmail confirmation is recognised');
select is((select code from public.forwarding_confirmations where feed_id = 'aaaaaaaa-0000-4000-8000-000000000001'), '957493560', 'its code is stored');
select is((select count(*)::int from public.messages where sender = 'forwarding-noreply@google.com'), 0, 'it is not stored as a message');
select throws_ok($$ insert into public.forwarding_confirmations (feed_id, provider, code, confirm_url, expires_at)
                    values ('aaaaaaaa-0000-4000-8000-000000000001', 'gmail', '123456', 'https://evil.example/x', now()) $$,
  '23514', null, 'only Google confirmation links can be stored');

-- ---------------------------------------------------------------- decisions (as Bob, then Alice)
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(format('select public.decide_sender(%L, true)', (select id from public.sources where sender_email = 'chair@pta.example.test')),
  'P0002', null, 'a stranger cannot approve a sender');
select is((select count(*)::int from public.forwarding_confirmations), 0, 'a stranger cannot see the confirmation code');
select throws_ok($$ select public.rotate_intake_address('aaaaaaaa-0000-4000-8000-000000000001') $$, '42501', null,
  'a stranger cannot change the address');
reset role;

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$ update public.sources set trusted = true where sender_email = 'chair@pta.example.test' $$, '42501', null,
  'trust changes only through decide_sender');
select is(public.decide_sender((select id from public.sources where sender_email = 'chair@pta.example.test'), true), 1,
  'approving a sender releases its waiting mail');
select is((select count(*)::int from public.forwarding_confirmations), 1, 'the owner sees the confirmation code');
select is(public.decide_message((select id from public.messages where message_id_header = '<f1@school.example.test>'), false), true,
  'the owner can ignore one suspicious message');
select matches(public.rotate_intake_address('aaaaaaaa-0000-4000-8000-000000000001'), '^feed-[a-z2-7]{20}$', 'the owner can get a new address');
reset role;
select is(pg_temp.queued(), 2::bigint, 'the released message is queued');
select is((select status from public.messages where message_id_header = '<f1@school.example.test>'), 'ignored', 'the ignored one is ignored');
select is((select count(*)::int from public.messages where quarantine_reason is not null), 0, 'nothing is left waiting');

-- Decline: future mail from that sender is dropped quietly.
update public.feeds set intake_address = 'feed-aliceschoolfeed23456' where id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(pg_temp.commit(pg_temp.start('feed-aliceschoolfeed23456'), '<s1@spam.example.test>', 'ads@spam.example.test', 'spam 1') ->> 'outcome',
  'quarantined', 'a new sender waits');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select is(public.decide_sender((select id from public.sources where sender_email = 'ads@spam.example.test'), false), 1,
  'declining ignores its waiting mail');
reset role;
select is(pg_temp.commit(pg_temp.start('feed-aliceschoolfeed23456'), '<s2@spam.example.test>', 'ads@spam.example.test', 'spam 2') ->> 'outcome',
  'blocked', 'later mail from a declined sender is dropped');

-- ---------------------------------------------------------------- daily cap
insert into private.ingest_tickets (feed_id, storage_path, declared_bytes, expires_at)
  select 'bbbbbbbb-0000-4000-8000-000000000001', 'cap/' || i, 1, now() + interval '15 minutes' from generate_series(1, 50) i;
select is(public.ingest_start((select intake_address from public.feeds where id = 'bbbbbbbb-0000-4000-8000-000000000001'), 10) ->> 'reject',
  'daily_limit', 'after 50 emails in 24 hours a feed refuses more');

-- ---------------------------------------------------------------- expiry
update public.messages set expires_at = now() - interval '1 second', storage_path = 'aaaaaaaa-0000-4000-8000-000000000001/old.eml'
  where message_id_header = '<m1@school.example.test>';
update private.ingest_tickets set expires_at = now() - interval '2 hours' where storage_path = 'cap/1';
select is((private.expire_intake() ->> 'messages')::int, 1, 'expired messages are deleted');
select ok(exists (select 1 from private.storage_trash where path = 'aaaaaaaa-0000-4000-8000-000000000001/old.eml'),
  'the expired message''s raw file is queued for deletion');
select ok(exists (select 1 from private.storage_trash where path = 'cap/1'), 'an abandoned upload is queued for deletion');
select ok(exists (select 1 from cron.job where jobname = 'feedcal-expire-intake'), 'expiry runs daily on pg_cron');

-- ---------------------------------------------------------------- storage
select is((select public from storage.buckets where id = 'inbound-raw'), false, 'the raw bucket is private');

select * from finish();
rollback;
