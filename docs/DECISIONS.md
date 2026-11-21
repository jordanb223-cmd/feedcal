# Decisions

Each entry: date, decision, why, and what would change it.

## D1 — Supabase for data, auth, storage, jobs (2026-11-20)
Postgres with RLS lets the database itself enforce who can see a feed. Auth, Storage, Queues (pgmq), pg_cron and Edge Functions come in one platform. Would change if Edge Function time limits block core processing (see D6).

## D2 — Cloudflare for domain, web and inbound email (2026-11-20)
Supabase can't receive email; Cloudflare Email Routing can hand mail to a Worker. Pages serves calendar files with custom headers and caching. GitHub Pages isn't used: Pages sites are public and GitHub limits commercial use (`UNVERIFIED` — check current GitHub Pages docs).

## D3 — GitHub for code, CI and deploys (2026-11-20)
Private repo, Actions for checks and deploys, Dependabot, gitleaks.

## D4 — Forwarding before the Gmail API (2026-11-20)
A forwarding address per feed needs no access to anyone's mailbox, so no Google restricted-scope review. The Gmail connection (Phase 17) needs `gmail.readonly`, a restricted scope (`UNVERIFIED` — confirm review steps and timing in Google's current docs before Phase 17).

## D5 — Buy Me a Coffee for donations (2026-11-20)
No card data on our servers. Webhooks are signature-checked (header and algorithm `UNVERIFIED` until Phase 15).

## D6 — Cloudflare Worker fallback for oversized PDFs (2026-11-20)
Large PDFs may exceed Edge Function time or memory limits. A Worker processor takes over only for those files.

## D7 — Hono on Cloudflare Pages advanced mode (2026-11-20)
The plan allowed Hono or SvelteKit. Hono is chosen: small, server-rendered HTML fits "no heavy SPA," and it runs unchanged in Pages, Workers and Vitest. The app is bundled by esbuild into `dist/_worker.js`; version and commit are injected at build time.

## D8 — npm workspaces (2026-11-20)
No extra tool to install. Packages export TypeScript source directly (`exports: ./src/index.ts`); the web build bundles them.

## D9 — Feed tokens stored as hash + Vault-encrypted copy (2026-11-20)
From BUILD-PLAN revision 1. Lookup uses SHA-256 of the token; the owner can view the link again from a Vault-encrypted copy. Implemented in Phase 2.

## D10 — Health probe via an anon-callable RPC (2026-11-20)
`public.health_check()` returns `true` and reads no tables, so exposing it to `anon` reveals nothing. The web app never holds the service-role key.
