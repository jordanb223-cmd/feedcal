# Threat model

STRIDE review of Feedcal, Phase 16 (D37), 2026-11-21. Each risk has an owner and a fix. "Owner" is the project owner: Feedcal has one maintainer. A risk is **Done** when the fix is in the code and a test proves it. **Open** means the fix needs the owner's accounts, money or a decision.

STRIDE: **S**poofing, **T**ampering, **R**epudiation, **I**nformation disclosure, **D**enial of service, **E**levation of privilege.

## What we protect

| Asset | Where it lives | Why it matters |
|---|---|---|
| Feed tokens (the secret in every calendar link) | SHA-256 hash in `feeds`; the token itself in Vault | Anyone with a token reads a private calendar |
| Forwarded emails and attachments | `messages` and private Storage, 30 days | They can name children, places and times |
| Accounts and sessions | Supabase Auth; HttpOnly session cookies | Takeover means control of calendars many families follow |
| Keys | Vault (unsubscribe HMAC key, sign-in salt); Supabase and Cloudflare secrets (service role, ingest HMAC, BMC, AI) | Forged links, forged webhooks, spending |
| Money and quotas | Anthropic API spend; free-tier limits | Cost exhaustion takes the service down |

## Trust boundaries

1. **Internet → Email Worker.** Anyone can send email to an intake address.
2. **Worker → Edge Functions.** HMAC-signed calls only (D26).
3. **Browser → web app (Cloudflare Pages).** The anon key plus the user's session. The web app never holds the service-role key.
4. **Web app and anyone with the anon key → Postgres API.** RLS on every table. Functions grant execute narrowly.
5. **Buy Me a Coffee → `bmc-webhook`.** HMAC-signed (D36).
6. **Edge Functions → Anthropic.** Email text leaves our systems here.

## Risks

| # | Risk (STRIDE) | What stops it today (evidence) | Residual risk | Fix / next step | Owner | Status |
|---|---|---|---|---|---|---|
| T1 | **Forged inbound email** (S, T): someone sends a fake "schedule change" as the school | First email from a new sender waits for the owner's OK. A trusted sender's email that fails DMARC is quarantined (pgTAP 008). Events quote their source sentence. An update applies by itself only from a trusted sender, at or above the feed's confidence threshold (default 0.85), with no review reasons; anything else goes to review (D31). | A trusted sender's own account being hacked | Owners review changes; the weekly digest lists what changed | Project owner | Done |
| T2 | **Feed token guessing** (I) | 256-bit random tokens, looked up by hash (pgTAP 003). "Make a new link" rotates them. The web route turns away an address after 30 misses in 10 minutes with 429 (pgTAP 018, unit `hardening.test.ts`). | The limit trusts the address the web app passes. A direct API caller, or one claiming a Google user agent, isn't limited. Guessing 2^256 tokens is still infeasible. | Put Cloudflare rate limiting (one free rule) on `/f/*` once the domain exists | Project owner | Done (code); Open (Cloudflare rule) |
| T3 | **Token leak from a database dump** (I) | Only the hash is in `feeds`. The token is in Vault, encrypted with a key that isn't in the database. pgTAP 018 checks that the stored Vault column doesn't contain the token. | Someone holding both a dump and the project's Vault key | Keep the Supabase account behind 2FA (SETUP) | Project owner | Done |
| T4 | **Prompt injection in emails** (T, E): an email tells the AI to publish or change things | Instructions in emails are flagged and held (`looksLikeInjection`). Every event must quote text found in the email. Structured outputs only, and the request offers the model no tools (D30; eval suite in `npm run test:functions`). | A cleverly worded email still yields a wrong held event | Human review; the eval set grows with real misses | Project owner | Done |
| T5 | **Malicious PDFs and images** (T, D) | Type and size checked before reading. Not-really-PDF and encrypted files are refused. Each parse stops after 20 seconds and frees its memory. Embedded JavaScript is never run. Pages sent to vision are copied into a fresh PDF. All in `triage.test.ts`. Parsing runs in Edge Functions, apart from the web app. | Memory limits are Supabase's per-function limits (value UNVERIFIED). A parser bug inside pdf.js itself | Keep `unpdf` updated (Dependabot) | Project owner | Done |
| T6 | **Account takeover** (S) | Magic link or Google only, no passwords. Our limit on sign-in emails (pgTAP 007), plus Supabase Auth's own limits. Session cookies are HttpOnly, SameSite=Lax, Secure and now session-only. Admins need a TOTP second factor (D35). "Sign out everywhere". | A user's own mailbox being taken over | Out of our hands; the account page shows the signed-in address | Project owner | Done |
| T7 | **Cross-site attacks (XSS, CSRF, clickjacking)** (T, E) | All output escaped (`hono/html`). CSRF double-submit token plus an Origin check on every POST (auth tests). A strict CSP with no inline scripts (`hardening.test.ts`, `tests/unit/no-inline-scripts.test.ts`). `frame-ancestors 'none'`. | `style-src-attr 'unsafe-inline'` (style attributes can't run code) | None needed | Project owner | Done |
| T8 | **Webhook forgery** (S): fake donations or fake emails | Ingest calls and BMC webhooks are HMAC-SHA256 checked in constant time, before any database write (Deno tests, integration tests). Each event id counts once. | A stolen signing secret | Rotate: SETUP §12 and §6 explain how; secrets never live in the repo (gitleaks in CI) | Project owner | Done |
| T9 | **Leaks through public feeds and pages** (I) | Private feeds have no page. Unlisted ones are never listed or indexed. Public pages show only granted columns, and the directory runs with the anon key and no session (pgTAP 001, 015). Personal details in events go to review (D35). | An owner publishing something they shouldn't | The report button and the admin queue; hiding is one click | Project owner | Done |
| T10 | **Cost exhaustion** (D): floods of email or AI calls | Daily caps per owner on intake, text pages and vision pages (`usage_daily`). At most 5 pages per email. Size and page limits. New accounts limited to 3 feeds (D35). Rate limits on public pages (D37). | A free-tier quota being hit by legitimate growth | Done in Phase 18: spend alerts, and AI work pauses at 80% of the monthly budget (pgTAP 019, D38). Owner sets the real budget (SETUP §14). | Project owner | Done |
| T11 | **Elevation via the database API** (E) | RLS on every table. Functions are SECURITY DEFINER with an empty search path, and execute is granted narrowly (pgTAP 001 onward). Supabase's security advisor shows no warnings (D37). | A future migration that forgets a grant | The advisor and pgTAP run on every pull request | Project owner | Done |
| T12 | **Repudiation of admin actions** (R) | Every admin action writes `admin_audit` (who, what, why). Event changes keep revisions with their actor. | Database superusers can edit the logs | Accepted at this size | Project owner | Done |
| T13 | **Losing the database** (D) | Daily encrypted backups to GitHub artifacts (7 days, plus weekly for 90; workflow `backup.yml`). The restore drill passed locally (D37). | Off until the owner adds `BACKUP_DB_URL` and `BACKUP_PASSPHRASE`. Not yet drilled with a hosted backup. | SETUP §13, then run `scripts/restore-drill.sh` on yesterday's backup | Project owner | Open (secrets) |
| T14 | **Abusing public endpoints** (D) | Limits: sign-in emails, report forms, feed misses, directory search (60 a minute), subscribe taps (30 a minute). Webhooks reject bad signatures before any work. | The Supabase API itself is reachable with the public anon key. Its platform limits are UNVERIFIED. | Cloudflare in front of the web app; `abuse_spike` alerts on floods (D38) | Project owner | Done (app, alert); Open (platform) |
| T15 | **Supply chain** (T) | Exact dependency pins, `npm audit` in CI, Dependabot, gitleaks. Every GitHub Action pinned by commit SHA (unit test). | A compromised upstream release that Dependabot proposes and we merge | Every action is pinned by commit SHA; `tests/unit/actions-pinned.test.ts` keeps it that way | Project owner | Done |

## Not in scope

The calendar apps themselves (Google, Apple, Microsoft). How those companies cache feeds isn't something Feedcal controls.
