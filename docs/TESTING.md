# Testing

## Automated (every pull request)

| Command | What it covers |
|---|---|
| `npm test` | Unit tests: web routes, sign-in, CSRF and origin checks, calendar output (golden files, ical.js validation), subscribe and share pages |
| `npm run test:functions` | Edge Function logic (Deno) |
| `npm run db:test` | pgTAP: RLS isolation, tokens, accounts, feeds, subscribe counts, seed sanity |
| CI `Secret scan` | gitleaks over the full git history |

Regenerate calendar golden files only after reading the diff:
```bash
UPDATE_GOLDEN=1 npx vitest run packages/ics
```

## Phase 5 usability script: three people subscribe without help

**Goal:** three non-technical people subscribe to a feed on their own phones, with no help. At least one uses an iPhone and one an Android phone.

**Before you start**
1. A public feed with at least three upcoming events, deployed to staging.
2. Its page link (`/c/<slug>`). Send it to each person by text message, the way an organizer would.
3. Note whether the text preview shows the feed's name. That's the second "passes when" check.

**What to say (exactly)**
> "A school uses this to share its calendar. Please get it into your phone's calendar. I can't help, but please think out loud."

**Watch for, and write down**
- Seconds from opening the text to the calendar showing an event.
- Every pause longer than 5 seconds, and what was on screen.
- Whether they used the top button, or opened "Other ways to subscribe".
- Android: whether Google Calendar in the browser accepted the link, or they needed the fallback steps.
- Anything they said that shows confusion ("is this safe?", "where did it go?").

**Passes when** all three have the events in their calendar without help, and an iPhone and an Android phone both preview the link with the feed name.

**Afterwards**
- Edit one event's time. Check, within the app's refresh window, that it moved on their phones and didn't appear twice.
- Record the results under "Results" below. Don't record names; use "Person A".

### Results
_Not run yet. Needs the staging deploy (docs/SETUP.md §5)._
