# AI provider down, or AI work paused

Triggers: extraction errors in the `extract-events` logs, Anthropic's status page, or an `ai_throttle` alert (the month's spend reached 80% of the budget).

- **Provider down:** nothing to do in the app. Messages wait as `waiting` and are retried (`public.requeue_waiting_extractions()`, D30). Attachments still waiting show "Waiting to be read" under Recent emails. When the provider is back, the queue drains by itself. Watch the `queue_backlog` alert.
- **Paused by the budget throttle:** AI calls and vision pages get no quota until the month's spend drops below 80% (next month) or the budget rises. To raise it, as an admin in the SQL editor: `update private.ops_settings set monthly_ai_budget_usd = <new amount>;`. Text from PDFs is still read; only AI work waits.
- **Key revoked or out of credit:** set a new key with `npx supabase secrets set ANTHROPIC_API_KEY=… --project-ref <ref>`.
