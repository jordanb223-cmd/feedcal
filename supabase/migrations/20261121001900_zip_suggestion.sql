-- D44: the calendar's area (ZIP) is found, not typed (2026-11-21, owner's request: "the ai should
-- be able to detect it ... painless and nearly automatic, especially for public ones").
-- Feedcal looks for ZIPs written as part of an address ("Sacramento, CA 95818") in the calendar's
-- event places and in emails from senders the owner approved. Only real ZIPs (public.zip_codes)
-- count; the one in the most places wins. Nothing is guessed: no address, no suggestion.
-- The owner sees it only when choosing Public, and confirms or changes it.

create function public.feed_zip_suggestion(p_feed_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.assert_feed_owner(p_feed_id);
  with texts as (
    select e.id::text as src, e.location as t from public.events e
      where e.feed_id = p_feed_id and e.location is not null
    union all
    select m.id::text, m.clean_text from public.messages m join public.sources s on s.id = m.source_id
      where m.feed_id = p_feed_id and s.trusted and m.clean_text is not null
  ), found as (
    -- A two-letter US state code, then the ZIP (ZIP+4 allowed): the way addresses end.
    select distinct t.src, (regexp_matches(t.t,
      '\m(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|PR|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\.?,?\s+(\d{5})(?:-\d{4})?\M',
      'g'))[1] as zip
    from texts t
  )
  select jsonb_build_object('zip', f.zip, 'places', count(*)) into v
  from found f join public.zip_codes z on z.zip = f.zip
  group by f.zip order by count(*) desc, f.zip limit 1;
  return v;
end;
$$;
revoke all on function public.feed_zip_suggestion(uuid) from public, anon;
grant execute on function public.feed_zip_suggestion(uuid) to authenticated;
