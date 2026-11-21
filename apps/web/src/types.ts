import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Logger } from "@feedcal/shared";
import type { Bindings } from "./env.js";

export type Supa = SupabaseClient<Database>;

export interface SessionUser {
  id: string;
  email: string | null;
}

export interface Variables {
  requestId: string;
  log: Logger;
  supabase: Supa;
  /** undefined until currentUser() has checked the session. */
  user: SessionUser | null | undefined;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}
