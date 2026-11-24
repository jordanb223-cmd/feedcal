-- D75: (1) an email may carry up to 20 attachments (was 10); (2) a page read from a picture can be
-- marked "transcription_unsure" when the two models that read it disagreed on a date or time.

create or replace function private.intake_limits()
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'max_bytes', 20 * 1024 * 1024,
    'max_attachments', 20,
    'per_feed_per_day', 50,
    'ticket_minutes', 15,
    'confirmation_days', 7)
$$;

alter table public.attachment_pages drop constraint attachment_pages_text_source_check;
alter table public.attachment_pages add constraint attachment_pages_text_source_check
  check (text_source in ('text_layer', 'transcription', 'transcription_unsure'));

-- record_triage stored any non-"transcription" source as "text_layer". Keep the new value.
do $$
declare
  f record;
  n integer := 0;
begin
  for f in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'record_triage' and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%case when p ->> ''source'' = ''transcription'' then ''transcription'' else ''text_layer'' end%'
  loop
    execute replace(f.def, 'case when p ->> ''source'' = ''transcription'' then ''transcription'' else ''text_layer'' end',
      'case when p ->> ''source'' in (''transcription'', ''transcription_unsure'') then p ->> ''source'' else ''text_layer'' end');
    n := n + 1;
  end loop;
  if n <> 1 then
    raise exception 'two-pass reading: expected to change record_triage once, changed % functions', n;
  end if;
end;
$$;
