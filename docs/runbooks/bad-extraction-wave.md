# A wave of bad extractions

Triggers: several "Report a problem" emails about wrong events, an `ai_spend_daily` alert, or many review items on one feed.

1. **Find the feed.** `/admin` shows reports. Or, in the SQL editor: `select feed_id, count(*) from public.event_candidates where created_at > now() - interval '1 day' group by 1 order by 2 desc limit 5;`.
2. **Stop the bleeding for that feed:** raise its confidence threshold in the feed's settings, so changes need review. If a sender is the problem, the owner can remove it as trusted.
3. **Undo published mistakes:** the owner cancels wrong events from the review screen. Subscribers' calendars update on their next fetch.
4. **Is it the model?** If many feeds are affected at once, check whether a prompt or model change went out. Run the evaluation (`npm run test:functions`; live: see TESTING.md) and roll back the change if precision dropped.
5. Add the bad emails (with personal details removed) to the evaluation fixtures so it can't happen again silently.
