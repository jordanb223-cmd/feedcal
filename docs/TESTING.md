# Testing

## Automated (every pull request)

| Command | What it covers |
|---|---|
| `npm test` | Unit tests: web routes, sign-in, CSRF and origin checks, calendar output (golden files, ical.js validation), subscribe and share pages |
| Extraction evaluation (in `npm run test:functions`) | 50 labelled fixtures in `supabase/functions/_shared/extract/eval/`, replayed with recorded model replies. Fails if precision, unflagged precision, recall, date or time accuracy drop more than 3 points from `baseline.json`, or if any event lacks its quote or an injected email could publish. Live run: `EVAL_LIVE=1 ANTHROPIC_API_KEY=… deno test -A supabase/functions/_shared/extract/eval/` (costs money). |
| `npm run test:functions` | Edge Function logic (Deno), including the 26 Phase 7 parsing fixtures in `supabase/functions/_shared/parse/fixtures` (rebuild them with the command at the top of `build.ts`) |
| `npm run db:test` | pgTAP: RLS isolation, tokens, accounts, feeds, subscribe counts, seed sanity, sign-in limits, email intake |
| `npm run test:integration` | Against the local stack: a stranger can't reach another user's share kit; email intake end to end (Worker code → Edge Functions → Storage → SQL → queue); parsing end to end (queue → `process-messages` → stored text and attachments); triage end to end (pages kept, the owner's "this one" as a real user, the next email routed by the learned rule) |
| CI `Secret scan` | gitleaks over the full git history |

Regenerate calendar golden files only after reading the diff:
```bash
UPDATE_GOLDEN=1 npx vitest run packages/ics
```

## Phase 6 hand test: a real Gmail forward (needs SETUP §7)
1. Create a test feed, open **Email forwarding** from the account page, and copy the address.
2. In a real Gmail account, add it as a forwarding address. **Pass:** within a minute a "Confirm on google.com" button (and the code) shows on the email page. Click it, refresh Gmail settings, and the address shows as verified. Note the confirmation email's real sender and subject in the results (D27).
3. Make a filter that forwards one sender's mail, then have that sender email you. **Pass:** "Use emails from … ?" appears; tap Yes.
4. Forward the same email again by hand. **Pass:** no second copy (the waiting count doesn't change; the Worker log says `duplicate`).
5. Send a 21 MB attachment. **Pass:** the sender gets the "larger than 20 MB" bounce.
6. Record the Authentication-Results line Cloudflare added (Worker log shows `dmarc=`), and whether Gmail-forwarded mail passed DMARC.

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
