// AI event extraction lives with the Edge Functions that run it:
//   supabase/functions/_shared/extract/  (prompt, schema, checks, pipeline, 50-fixture evaluation)
// It's Deno code because only Edge Functions hold the API key (D30). This package stays as the
// place for any Node-side helpers that later phases need.
export const EXTRACT_PACKAGE_PHASE = 9 as const;
export const EXTRACT_SOURCE = "supabase/functions/_shared/extract" as const;
