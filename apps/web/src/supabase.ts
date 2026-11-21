import { createServerClient } from "@supabase/ssr";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Database } from "@feedcal/shared";
import { isSecure } from "./security.js";
import type { AppEnv, Supa } from "./types.js";

/**
 * One Supabase client per request, using the anon key and the user's session cookies.
 * Session cookies are HttpOnly: no browser script ever reads them, because the app has
 * no browser-side Supabase client.
 */
export function createSupabase(c: Context<AppEnv>): Supa {
  const anonKey = c.env.SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error("SUPABASE_ANON_KEY is not configured");
  const secure = isSecure(c);
  return createServerClient<Database>(c.env.SUPABASE_URL, anonKey, {
    cookieOptions: { path: "/", httpOnly: true, secure, sameSite: "lax" },
    cookies: {
      getAll: () => Object.entries(getCookie(c)).map(([name, value]) => ({ name, value })),
      setAll: (cookies, headers) => {
        for (const { name, value, options } of cookies) {
          setCookie(c, name, value, {
            path: options.path ?? "/",
            httpOnly: true,
            secure,
            sameSite: "Lax",
            ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}),
            ...(options.expires !== undefined ? { expires: options.expires } : {}),
          });
        }
        for (const [key, value] of Object.entries(headers)) c.header(key, value);
      },
    },
  });
}
