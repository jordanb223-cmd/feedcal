# Runbooks

What to do when something goes wrong (Phase 18, D38). Each alert email names its runbook.

| Situation | Runbook | How you hear about it |
|---|---|---|
| Site down or slow | [outage](runbooks/outage.md) | "Outage" GitHub issue from the Uptime workflow |
| Emails stuck in a queue | [queue-backlog](runbooks/queue-backlog.md) | `queue_backlog` alert email |
| AI provider down, or AI paused by the budget | [ai-outage](runbooks/ai-outage.md) | `ai_throttle` alert; extraction errors |
| Many wrong events | [bad-extraction-wave](runbooks/bad-extraction-wave.md) | Reports; `ai_spend_daily` alert |
| Spam or abuse | [spam-wave](runbooks/spam-wave.md) | `abuse_spike` alert; flags in `/admin` |
| A calendar link, address or secret leaked | [leaked-token](runbooks/leaked-token.md), [secret-rotation](runbooks/secret-rotation.md) | People tell you; gitleaks |
| Google blocks sign-in or Gmail | [google-revokes-access](runbooks/google-revokes-access.md) | Google's email; sign-in errors |
| Account deletions overdue | [purge-stuck](runbooks/purge-stuck.md) | `purge_stuck` alert |
| Database lost or corrupted | [restore](runbooks/restore.md) | Outage; errors everywhere |
| Laptop lost or stolen | [stolen-laptop](runbooks/stolen-laptop.md) | You |

After an incident: [postmortem template](runbooks/postmortem-template.md).

**Alerts and drills.** Alerts are checked every 5 minutes in the database (`private.check_alerts`) and emailed to every admin. Run the drill from `/admin` → Operations → "Run the alert drill": every alert fires once, marked as a drill.
