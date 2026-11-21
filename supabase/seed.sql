-- Local seed data. Fake people, fake emails (example.test is reserved and never delivers).
-- Two users: Alice owns three feeds (public, unlisted, private); Bob owns one private feed.

-- Token columns must be '' (not NULL): the auth server can't read NULL there, and sign-in fails.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change,
                        email_change_token_current, reauthentication_token, phone_change, phone_change_token,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated',
   'authenticated', 'alice@example.test', '', now(), '', '', '', '', '', '', '', '',
   '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated',
   'authenticated', 'bob@example.test', '', now(), '', '', '', '', '', '', '', '',
   '{"provider":"email","providers":["email"]}', '{}', now(), now());

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), 'email', now(), now(), now()
from auth.users u where u.id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

insert into public.profiles (id, display_name) values
  ('11111111-1111-4111-8111-111111111111', 'Alice Organizer'),
  ('22222222-2222-4222-8222-222222222222', 'Bob Coach')
on conflict (id) do update set display_name = excluded.display_name;

insert into public.feeds (id, owner_id, name, slug, description, category, zip_code, location, visibility) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'Sutterville Kindergarten', 'sutterville-kindergarten', 'Class events, field trips and early dismissals.',
   'school', '95818', extensions.st_point(-121.4944, 38.5536, 4326)::extensions.geography, 'public'),
  ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
   'Room 12 Parents', 'room-12-parents', 'Only for Room 12 families.', 'school', '95818', null, 'unlisted'),
  ('aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
   'Alice Private Drafts', 'alice-private-drafts', null, null, null, null, 'private'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222',
   'Bob U10 Soccer', 'bob-u10-soccer', 'Practice and game schedule.', 'sports', '95822', null, 'private');

insert into public.sources (id, feed_id, sender_email, sender_domain, trusted) values
  ('cccccccc-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'office@school.example.test', 'school.example.test', true);

insert into public.messages (id, feed_id, source_id, message_id_header, sender, subject, status) values
  ('dddddddd-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'cccccccc-0000-4000-8000-000000000001', '<seed-1@school.example.test>', 'office@school.example.test',
   'November newsletter', 'extracted'),
  ('dddddddd-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000001',
   null, '<seed-2@league.example.test>', 'coach@league.example.test', 'Practice moved', 'extracted');

insert into public.attachments (id, message_id, filename, mime, bytes, pages, chosen, status) values
  ('eeeeeeee-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001',
   'newsletter.pdf', 'application/pdf', 182044, 2, true, 'text_layer');

insert into public.attachment_pages (attachment_id, page_index, text, text_source) values
  ('eeeeeeee-0000-4000-8000-000000000001', 0, 'Pumpkin patch field trip on Friday at 9:00 am.', 'text_layer'),
  ('eeeeeeee-0000-4000-8000-000000000001', 1, 'No school on Monday.', 'text_layer');

insert into public.events (feed_id, title, starts_at, ends_at, timezone, status, confidence,
                           source_message_id, evidence_quote, published) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Pumpkin patch field trip',
   date_trunc('day', now()) + interval '3 days 17 hours', date_trunc('day', now()) + interval '3 days 20 hours',
   'America/Los_Angeles', 'confirmed', 0.950, 'dddddddd-0000-4000-8000-000000000001',
   'Pumpkin patch field trip on Friday at 9:00 am.', true),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Draft: picture day (not yet approved)',
   date_trunc('day', now()) + interval '10 days 16 hours', null,
   'America/Los_Angeles', 'tentative', 0.410, 'dddddddd-0000-4000-8000-000000000001', null, false),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'Room 12 potluck',
   date_trunc('day', now()) + interval '5 days 1 hour', null, 'America/Los_Angeles', 'confirmed', 0.900, null, null, true),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'U10 practice',
   date_trunc('day', now()) + interval '2 days 1 hour', null, 'America/Los_Angeles', 'confirmed', 0.880,
   'dddddddd-0000-4000-8000-000000000002', 'Practice moved to Thursday', true);
