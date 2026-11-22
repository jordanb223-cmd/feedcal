declare global {
  const __APP_VERSION__: string;
  const __GIT_SHA__: string;
}

export interface Bindings {
  ENVIRONMENT: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY?: string;
  /** "on" once the Google OAuth client is configured for this environment. */
  GOOGLE_SIGN_IN?: string;
  /** Domain that receives forwarded email (e.g. in.feedcal.app). Unset until Email Routing exists. */
  INTAKE_DOMAIN?: string;
  /** Buy Me a Coffee page name (D36). Unset: no donation link is shown. */
  BMC_USERNAME?: string;
  /** HSTS max-age in seconds (D37). Default one day; a year once the domain is settled. */
  HSTS_MAX_AGE?: string;
  /** Google OAuth client id for the Gmail connection (public; D39). Unset: no "Connect Gmail". */
  GMAIL_CLIENT_ID?: string;
  /** D51: server-only proof for database calls (set by the deploy from Vault). Never sent to browsers. */
  RPC_PROXY_KEY?: string;
}
