declare global {
  const __APP_VERSION__: string;
  const __GIT_SHA__: string;
}

export interface Bindings {
  ENVIRONMENT: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY?: string;
}
