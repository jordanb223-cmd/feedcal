# What an AI coding agent may hold

Prompt F, item 46 (D37). This covers any AI coding agent working on Feedcal, such as Claude Code.

## Allowed
- **Local development only.** The local Supabase stack (Colima) and its local keys, which are printed by `npx supabase status` and are not secret outside this machine.
- **The GitHub CLI's token** on the owner's machine, to push branches, open pull requests and read CI. Commits use the noreply address `242484726+jordanb223-cmd@users.noreply.github.com`.
- **Random local test values** it makes itself, in gitignored files (`supabase/functions/.env`).

## Never
- Production or staging database URLs, passwords or service-role keys.
- The Supabase access token, Cloudflare API token, Anthropic, Resend or Buy Me a Coffee keys, or backup passphrases. The owner adds these as GitHub or Supabase secrets personally.
- Secrets pasted into chat. If one appears, treat it as exposed and rotate it.
- Force-pushes, history rewrites, or merges that skip CI.

## Scope and revoking
- The GitHub token is the owner's own `gh` login. Revoke it with `gh auth logout`, then at github.com/settings/applications. See `docs/runbooks/stolen-laptop.md`.
- An agent can't change system settings, buy anything, create accounts, or download files without the owner saying yes in chat.
