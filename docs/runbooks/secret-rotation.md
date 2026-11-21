# Rotating secrets

Rotate on any suspected leak, when someone with access leaves, and yearly. Never paste a secret into chat or a commit.

| Secret | Where it lives | How to rotate |
|---|---|---|
| `INGEST_HMAC_SECRET` | Supabase function secrets + the Email Worker | Make a new random value; set it in both places (SETUP §7) in one go; intake pauses for the seconds in between |
| `BMC_WEBHOOK_SECRET` | Supabase function secrets | Regenerate in Buy Me a Coffee's webhook settings, then `npx supabase secrets set BMC_WEBHOOK_SECRET=…` |
| `ANTHROPIC_API_KEY` | Supabase function secrets | New key in the Anthropic console, set it, then delete the old key |
| `RESEND_API_KEY` | Supabase function secrets | Same pattern in Resend |
| Supabase service-role key | Supabase (JWT secret) | Rotate the JWT secret or API keys in the dashboard (exact steps UNVERIFIED; check Supabase's current docs). It changes the anon key too: update the Pages projects' `SUPABASE_ANON_KEY` and `private.app_settings.functions_key` |
| `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN` | GitHub secrets | New token in each dashboard, update the GitHub secret, revoke the old one |
| `BACKUP_PASSPHRASE` | GitHub secret + your password manager | Set a new one; older backups still need the old passphrase, so keep it until they age out (90 days) |
| Unsubscribe key, sign-in salt | Vault (D37) | `select vault.update_secret(id, encode(extensions.gen_random_bytes(32), 'hex')) from vault.secrets where name = 'feedcal_notification_key';`. Old unsubscribe links stop working |
| A feed token | Vault | The owner uses "Make a new link" |

After any rotation, check `/health` and send a test email through the pipeline.
