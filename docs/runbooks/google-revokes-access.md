# Google revokes access

Applies to Google sign-in (Phase 3) and, later, the Gmail connection (Phase 17).

- **Sign-in stops working** ("access blocked" or similar): check the OAuth consent screen in Google Cloud for a suspension notice or an expired verification. Until it's fixed, turn Google sign-in off (`GOOGLE_SIGN_IN` unset on the Pages project); people can still sign in with an email link.
- **Gmail connection revoked** (Phase 17, when built): forwarding by email keeps working, so tell owners to switch back to forwarding. Never ask for broader Gmail scopes to work around a review.
- Reply to Google's notice from the Google Cloud console. Keep the scopes as small as the build plan says.
