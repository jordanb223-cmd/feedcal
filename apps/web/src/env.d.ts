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
}
