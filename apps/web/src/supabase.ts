import { createServerClient } from "@supabase/ssr";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Database } from "@feedcal/shared";
import { isSecure } from "./security.js";
import type { AppEnv, Supa } from "./types.js";

/**
 * One Supabase client per request, using the anon key and the user's session cookies.
 * Session cookies are HttpOnly: no browser script ever reads them, because the app has
 * no browser-side Supabase client. They're session cookies: closing the browser signs you out.
 */
/**
 * D51: the server-only proof that a call comes from Feedcal's web server, so the database trusts
 * the visitor address it's given. Set by the deploy (Vault 'rpc_proxy_key'); never sent to browsers.
 */
export function proxyHeaders(c: Context<AppEnv>): Record<string, string> {
  return c.env.RPC_PROXY_KEY ? { "x-feedcal-proxy": c.env.RPC_PROXY_KEY } : {};
}

export function createSupabase(c: Context<AppEnv>): Supa {
  const anonKey = c.env.SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error("SUPABASE_ANON_KEY is not configured");
  const secure = isSecure(c);
  return createServerClient<Database>(c.env.SUPABASE_URL, anonKey, {
    global: { headers: proxyHeaders(c) },
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
            // Session-only (D37): no maxAge or expires, so the browser forgets the sign-in when it
            // closes. A cookie being cleared (maxAge 0) is the one exception.
            ...(options.maxAge === 0 ? { maxAge: 0 } : {}),
          });
        }
        for (const [key, value] of Object.entries(headers)) c.header(key, value);
      },
    },
  });
}
