# Outage: the first 10 minutes

Trigger: an "Outage" issue from the Uptime workflow (two failed checks in a row), or people saying calendars stopped updating.

1. **Minute 0–2: is it us?** Open `https://<site>/health`. If `database` is `false`, it's Supabase: check status.supabase.com. If the page doesn't load at all, it's Cloudflare or our deploy: check cloudflarestatus.com and the last Pages deployment.
2. **Minute 2–5: did we just deploy?** If a deploy went out in the last hour, roll the website back in Cloudflare Pages: Deployments → ⋯ on the previous deployment → **Rollback to this deployment** (checked against Cloudflare's docs, 2026-11-21). Functions and database changes go back differently: see `rollback.md`.
3. **Minute 5–8: are feeds being served?** Open one known feed link. Calendar apps cache feeds for hours, so a short outage doesn't empty people's calendars, but new events won't arrive.
4. **Minute 8–10: say something.** Comment on the Outage issue with what you know. If it's longer than an hour, post on the status page (SETUP §14).
5. **After:** close the issue by hand, and write a postmortem (`postmortem-template.md`) for anything over an hour or anything that lost data.
