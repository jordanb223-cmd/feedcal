# Spam or abuse wave

Triggers: an `abuse_spike` alert (over 500 rate-limited requests in 10 minutes), many automatic flags in `/admin`, or reports.

1. **Hide, then look.** In `/admin`, "Hide feed" takes one click and is audited. Hidden feeds vanish from pages, the directory and calendar fetches at once.
2. **Suspend the account** if it's clearly abuse: "Suspend" signs them out everywhere and hides all their feeds.
3. **Many new accounts?** New accounts already can't list publicly for 7 days and have at most 3 feeds (D35). If a wave gets past that, tighten Supabase Auth's rate limits in the dashboard.
4. **Traffic floods** (the `abuse_spike` alert): the app already answers 429. If it keeps up, add a Cloudflare rate-limiting rule on the path being hit (SETUP §13).
