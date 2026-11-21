# Security review

Phase 16 (D37), 2026-11-21, against the **OWASP Top 10:2025** (list checked at owasp.org/Top10/2025 on 2026-11-21). Scope: this repository and the local stack. Hosted settings (Supabase dashboard, Cloudflare) weren't reviewed: there is no hosted deploy yet.

**Pass** means the control is in the code and a named test proves it. **Partial** means part is missing; the gap is stated.

| Item | Result | Evidence | Gap |
|---|---|---|---|
| **A01 Broken Access Control** | Pass | RLS on every table. A user can't read another's feeds, messages or tokens (pgTAP 001), or reach another user's share kit (integration `stranger.test.ts`). Editors and owners are separate (pgTAP 013). Admin actions need the admin row **and** a second factor (pgTAP 016, integration `admin.test.ts`). Supporter data has no direct access (pgTAP 017). The web app holds only the anon key. | — |
| **A02 Security Misconfiguration** | Pass (local) | CSP, HSTS, nosniff, COOP, Permissions-Policy and frame denial on HTML pages, feeds and errors (`hardening.test.ts`). Error pages show a request id, never a stack trace (`app.ts` `onError`). Supabase's security advisor: no warnings or errors locally. The remaining info notes are explained in D37. | Hosted auth settings and the advisor on hosted projects (SETUP §13) |
| **A03 Software Supply Chain Failures** | Pass | Exact versions in `package-lock.json`, with `npm ci`. `npm audit --audit-level=high` in CI. Dependabot (npm and actions). gitleaks over the full history. Deno imports pin exact versions. Every GitHub Action is pinned to a commit SHA, enforced by `tests/unit/actions-pinned.test.ts`. | — |
| **A04 Cryptographic Failures** | Pass | HTTPS only, with HSTS. Feed tokens are 256-bit random, stored as SHA-256, with the token in Vault (pgTAP 003, 018). Keys are in Vault, not in tables (pgTAP 018). HMAC-SHA256 signatures compared in constant time (Deno `bmc.test.ts`, worker `handler.test.ts`). IPs and emails are stored only as salted hashes (pgTAP 007, 018). Backups are AES-256 encrypted. | — |
| **A05 Injection** | Pass | No SQL is built from strings: supabase-js parameters and PL/pgSQL variables, and the migrations contain no dynamic `execute`. HTML is escaped by `hono/html` (escaping tests in `auth.test.ts` and `review.test.ts`). JSON-LD escapes `<` (`directory.test.ts`). Calendar text is escaped by `packages/ics` (golden files). Prompt injection is handled in layers (D30; eval suite). | — |
| **A06 Insecure Design** | Pass | `docs/THREAT-MODEL.md`. Limits are designed in: daily AI caps, pages per email, new-account limits (D35), rate limits (D37). The first email from a new sender waits for approval. | — |
| **A07 Authentication Failures** | Pass | No passwords: a magic link or Google. Sign-in emails are limited per address and IP (pgTAP 007, `auth.test.ts`), and the check fails closed. A link opens a button, not a sign-in, so mail scanners can't use it. Sessions are HttpOnly, SameSite=Lax, Secure and session-only (`hardening.test.ts`). TOTP for admins. "Sign out everywhere". | — |
| **A08 Software or Data Integrity Failures** | Pass | Ingest and BMC webhooks are signed (HMAC) and each event id is recorded once (integration `intake.test.ts`, `donations.test.ts`). Deploys run only from CI. Generated types and state machines are checked in CI. | — |
| **A09 Security Logging and Alerting Failures** | Partial | Structured JSON logs with request ids. Tokens and emails are kept out of them (`redactPath`, log tests). Admin actions are audited (pgTAP 016). Origin and signature rejections are logged. | No alerting yet: nothing pages anyone on a spike of failures or 429s. That's Phase 18 (monitoring and alerts). |
| **A10 Mishandling of Exceptional Conditions** | Pass | One generic error page and JSON shape. Limit checks fail closed (`auth.test.ts`). The webhook returns 503 so BMC retries. One bad attachment doesn't stop the others (`triage.test.ts`). A slow PDF parse is stopped. | — |

**Result: 9 of 10 pass; 1 is partial** (A09 alerting, in Phase 18). A03 passed after a follow-up the same day, once every action was pinned by commit. Phase 16's "every item passes" isn't fully met until A09 is done; its owner and fix are in `docs/THREAT-MODEL.md` (T10, T14).

## ZAP baseline (Prompt F, item 48)
`.github/workflows/zap.yml` runs OWASP ZAP's passive baseline scan against staging every Monday, or by hand. It skips until staging answers `/health`. **Not run yet:** staging isn't deployed (it needs the owner's two GitHub secrets). Accepted rules are in `.zap/rules.tsv`, with reasons. The CSP rule id there (10055) is UNVERIFIED until the first run.

## OWASP ASVS level 1 (Prompt F, item 41)
Not done item by item. The table above touches the same areas, but only at a summary level. A full item-by-item ASVS 5.0 level 1 pass is still to do before public launch.
