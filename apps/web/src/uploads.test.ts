// D61: the upload routes' own checks. The end-to-end flow is in tests/integration/upload.test.ts.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";
import { publicUrl } from "./uploads.js";

const FEED = "aaaaaaaa-0000-4000-8000-000000000001";
const T = "0b9e2c1a-0000-4000-8000-000000000001";
const SIGNED = `http://kong:8000/storage/v1/object/upload/sign/attachments/${FEED}/upload-${T}/file.pdf?token=abc.def.ghi`;

describe("upload link rewriting (D61)", () => {
  it("moves a real storage upload link onto the public address, keeping path and token", () => {
    expect(publicUrl(SIGNED, "https://ref.supabase.co")).toBe(`https://ref.supabase.co/storage/v1/object/upload/sign/attachments/${FEED}/upload-${T}/file.pdf?token=abc.def.ghi`);
  });
  it.each([
    ["another bucket", SIGNED.replace("/attachments/", "/inbound-raw/")],
    ["a path outside an upload folder", `http://kong:8000/storage/v1/object/upload/sign/attachments/${FEED}/other/file.pdf?token=x`],
    ["a traversal", `http://kong:8000/storage/v1/object/upload/sign/attachments/${FEED}/upload-${T}/../../x.pdf?token=x`],
    ["no token", SIGNED.replace(/\?token=.*$/, "")],
    ["not a storage link", `http://kong:8000/auth/v1/admin/users?token=x`],
    ["not a URL", "javascript:alert(1)"],
  ])("refuses %s", (_, url) => {
    expect(publicUrl(url, "https://ref.supabase.co")).toBeNull();
  });
});

describe("upload routes (D61)", () => {
  const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon" };
  const app = (signedIn: boolean, invoke = async () => ({ data: { ticket: T, url: SIGNED }, error: null })) => createApp({ version: "1", commit: "c", logSink: () => {}, supabase: () => ({
    auth: { getUser: async () => (signedIn ? { data: { user: { id: "u1", email: "o@example.test" } }, error: null } : { data: { user: null }, error: { message: "x" } }) },
    functions: { invoke },
  }) as unknown as Supa });
  const post = (a: ReturnType<typeof app>, path: string, fields: Record<string, string>, cookie = "") =>
    a.request(`http://localhost:8788${path}`, { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:8788", cookie } }, env);

  it("needs a session and a valid token, and never calls the function otherwise", async () => {
    let calls = 0;
    const counting = async () => { calls++; return { data: { ticket: T, url: SIGNED }, error: null }; };
    expect((await post(app(false, counting), `/feeds/${FEED}/upload/start`, { filename: "a.pdf", mime: "application/pdf", bytes: "10" })).status).toBe(401);
    expect((await post(app(true, counting), `/feeds/${FEED}/upload/start`, { filename: "a.pdf", mime: "application/pdf", bytes: "10", csrf: "x".repeat(43) }, `feedcal_csrf=${"y".repeat(43)}`)).status).toBe(403);
    expect((await post(app(true, counting), `/feeds/not-a-feed/upload/start`, {})).status).toBe(404);
    expect(calls).toBe(0);
  });
  it("returns the rewritten link, and refuses one that isn't a storage upload link", async () => {
    const cookie = `feedcal_csrf=${"z".repeat(43)}`;
    const ok = await post(app(true), `/feeds/${FEED}/upload/start`, { filename: "a.pdf", mime: "application/pdf", bytes: "10", csrf: "z".repeat(43) }, cookie);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { url: string }).url).toMatch(/^https:\/\/ref\.supabase\.co\/storage\/v1\/object\/upload\/sign\//);
    const evil = await post(app(true, async () => ({ data: { ticket: T, url: "https://evil.example/steal" }, error: null })), `/feeds/${FEED}/upload/start`, { csrf: "z".repeat(43) }, cookie);
    expect(evil.status).toBe(503);
  });
});
