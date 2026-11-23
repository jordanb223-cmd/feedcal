-- Visitors could read the owner's internal id on public calendars. Nothing reads it as a
-- visitor: the web app's only direct visitor query on feeds selects slug and last_updated_at
-- (the sitemap), and public pages go through public_feed_page(). So take the grant away.
revoke select (owner_id) on table public.feeds from anon;
