// Phase 11 routes: dashboard, new feed, review queue, event editor, settings, undo (D32).
// Every page loads through the signed-in user's session, so RLS decides what exists: a feed
// you aren't a member of is simply "not found". Every change is an RPC that checks again.
import type { Context, Hono } from "hono";
import { z } from "zod";
import { currentUser, MESSAGES } from "./auth.js";
import { ImportStatus, importNotice } from "./imports.js";
import { CATEGORIES, dashboardPage, DONE, eventEditPage, feedHomePage, newFeedPage, REJECT_REASONS, settingsPage,
  type DashboardFeed, type DraftCard, type EmailGroup, type ReviewCard } from "./review-views.js";
import { csrfToken, csrfValid } from "./security.js";
import type { AppEnv, SessionUser } from "./types.js";
import { messagePage } from "./views.js";

const Id = z.uuid();
const IMAGE = /^image\/(jpeg|png|gif|webp)$/;
const Undo = z.uuid().optional();

const notFound = (c: Context<AppEnv>) => c.html(messagePage("Not found", "That doesn't exist, or it isn't yours."), 404);

async function body(c: Context<AppEnv>): Promise<Record<string, string>> {
  const b = await c.req.parseBody();
  return Object.fromEntries(Object.entries(b).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** Signed in + CSRF for POSTs. Returns the user, or a response to send instead. */
async function guard(c: Context<AppEnv>, form?: Record<string, string>): Promise<SessionUser | Response> {
  const user = await currentUser(c);
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 303);
  if (form && !csrfValid(c, form.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: "/feeds", text: "Back" }), 403);
  return user;
}

function local(iso: string, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** The quote in its surrounding text, for the review card; falls back to the quote alone. */
export function snippet(text: string | null, quote: string): { before: string; quote: string; after: string } {
  const src = text ?? "";
  const flat = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, "-").toLowerCase();
  const i = flat(src).indexOf(flat(quote));
  if (i < 0) return { before: "", quote, after: "" };
  return { before: src.slice(Math.max(0, i - 120), i), quote: src.slice(i, i + quote.length), after: src.slice(i + quote.length, i + quote.length + 120) };
}

function undoOf(c: Context<AppEnv>, back: string) {
  const u = Undo.safeParse(c.req.query("undo"));
  return u.success && u.data ? { id: u.data, back } : null;
}
const doneOf = (c: Context<AppEnv>) => {
  const d = c.req.query("done");
  return d && d in DONE ? d : undefined;
};

// D44: only ZIPs in the loaded list (public.zip_codes) are accepted, so a typo can't place a calendar.
const LEFT_OUT_WHY: Record<string, string> = {
  already_past: "the date has passed",
  date_out_of_range: "the date is too far off, or long past",
};
/**
 * D81: what an email's last read dropped, for the "left out" line. Only the two date reasons are
 * shown by name; anything else (a quote that couldn't be found, a bad time zone) is only counted,
 * because those can be things the email never really said.
 */
export function leftOutOf(extraction: unknown, timezone: string): { named: { title: string; when: string; why: string }[]; others: number } {
  const rejected = (extraction && typeof extraction === "object" && Array.isArray((extraction as { rejected?: unknown }).rejected))
    ? (extraction as { rejected: { event?: { title?: unknown; start?: unknown; timezone?: unknown }; reason?: unknown }[] }).rejected : [];
  const named: { title: string; when: string; why: string }[] = [];
  let others = 0;
  for (const r of rejected.slice(0, 60)) {
    const why = LEFT_OUT_WHY[String(r.reason)];
    const title = typeof r.event?.title === "string" ? r.event.title.slice(0, 120) : "";
    const start = typeof r.event?.start === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.event.start) ? r.event.start.slice(0, 10) : "";
    if (!why || !title || !start) { others++; continue; }
    const when = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${start}T12:00:00Z`));
    named.push({ title, when, why });
  }
  void timezone;
  return { named: named.slice(0, 10), others: others + Math.max(0, named.length - 10) };
}

/** The next coming date of a repeating event, as an ISO instant, or null when none is left. */
export function nextOccurrence(occurrences: string[] | null | undefined, now: Date): string | null {
  const t = now.getTime();
  const coming = (occurrences ?? []).map((o) => Date.parse(o)).filter((ms) => Number.isFinite(ms) && ms >= t).sort((a, b) => a - b);
  return coming[0] === undefined ? null : new Date(coming[0]).toISOString();
}

async function knownZip(c: Context<AppEnv>, zip: string): Promise<boolean> {
  const { data } = await c.get("supabase").from("zip_codes").select("zip").eq("zip", zip).maybeSingle();
  return Boolean(data);
}

async function loadFeed(c: Context<AppEnv>, id: string) {
  const { data } = await c.get("supabase").from("feeds")
    .select("id, name, description, owner_id, visibility, timezone, auto_publish_threshold, zip_code, delete_requested_at").eq("id", id).maybeSingle();
  return data && !data.delete_requested_at ? data : null;
}

export function registerReviewRoutes(app: Hono<AppEnv>): void {
  // ---------------------------------------------------------------- dashboard
  app.get("/feeds", async (c) => {
    const user = await guard(c);
    if (user instanceof Response) return user;
    const sb = c.get("supabase");
    const { data: feeds } = await sb.from("feeds").select("id, name, visibility, last_updated_at").is("delete_requested_at", null).order("name");
    const ids = (feeds ?? []).map((f) => f.id);
    const counts = new Map<string, number>();
    if (ids.length) {
      const [{ data: cands }, { data: drafts }] = await Promise.all([
        sb.from("event_candidates").select("feed_id").in("feed_id", ids).eq("state", "needs_review"),
        sb.from("events").select("feed_id").in("feed_id", ids).eq("published", false).eq("status", "tentative"),
      ]);
      for (const r of [...(cands ?? []), ...(drafts ?? [])]) counts.set(r.feed_id, (counts.get(r.feed_id) ?? 0) + 1);
    }
    const list: DashboardFeed[] = await Promise.all((feeds ?? []).map(async (f) => {
      const { data: stats } = await sb.rpc("feed_subscribe_stats", { p_feed_id: f.id });
      const subs = (stats as { subscribers_at_least?: number } | null)?.subscribers_at_least;
      return { id: f.id, name: f.name, visibility: f.visibility, lastUpdated: f.last_updated_at, reviewCount: counts.get(f.id) ?? 0, subscribers: typeof subs === "number" ? subs : null };
    }));
    return c.html(dashboardPage({ csrf: csrfToken(c), feeds: list, done: doneOf(c), undo: undoOf(c, "/feeds") }));
  });

  app.get("/feeds/new", async (c) => {
    const user = await guard(c);
    if (user instanceof Response) return user;
    return c.html(newFeedPage({ csrf: csrfToken(c) }));
  });

  app.post("/feeds/new", async (c) => {
    const form = await body(c);
    const user = await guard(c, form);
    if (user instanceof Response) return user;
    const parsed = z.object({
      name: z.string().trim().min(1).max(120),
      // D47: only the name is asked for; kind defaults to "other" and every calendar starts Private.
      category: z.enum(CATEGORIES).default("other"),
      visibility: z.enum(["public", "unlisted", "private"]).default("unlisted"),
      zip_code: z.string().trim().regex(/^(\d{5})?$/).default(""),
    }).safeParse(form);
    if (!parsed.success) return c.html(newFeedPage({ csrf: csrfToken(c), error: "Please give the calendar a name.", values: form }), 400);
    if (parsed.data.zip_code && !(await knownZip(c, parsed.data.zip_code))) {
      return c.html(newFeedPage({ csrf: csrfToken(c), error: `We don't know the ZIP code ${parsed.data.zip_code}. Check it, or leave it blank.`, values: form }), 400);
    }
    const slug = (parsed.data.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "feed")
      + "-" + crypto.randomUUID().slice(0, 6);
    // Public listing needs a published event (D35), which a new calendar can't have yet: start it
    // private and tell the owner how to switch.
    const wantsPublic = parsed.data.visibility === "public";
    const { data, error } = await c.get("supabase").from("feeds")
      .insert({ name: parsed.data.name, category: parsed.data.category, visibility: wantsPublic ? "unlisted" : parsed.data.visibility, slug,
        zip_code: parsed.data.zip_code || null } as never)
      .select("id").single();
    if (error || !data) return c.html(newFeedPage({ csrf: csrfToken(c), error: "We couldn't create the calendar. Please try again.", values: form }), 400);
    c.get("log").info("feed_created", { feed_id: data.id });
    // D47: next, the one question that matters: where do the emails come from?
    return c.redirect(`/feeds/${data.id}/setup${wantsPublic ? "?public_later=1" : ""}`, 303);
  });

  // ---------------------------------------------------------------- feed home + review queue
  app.get("/feeds/:id", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const user = await guard(c);
    if (user instanceof Response) return user;
    const feed = await loadFeed(c, id.data);
    if (!feed) return notFound(c);
    const sb = c.get("supabase");
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const [{ data: cands }, { data: drafts }, { data: listed }] = await Promise.all([
      sb.from("event_candidates").select("id, message_id, title, starts_at, all_day, timezone, location, confidence, outcome, change_kind, review_reasons, evidence_quote, source_kind, attachment_id, page_index, from_transcription, event_id")
        .eq("feed_id", id.data).eq("state", "needs_review").order("created_at").limit(50),
      sb.from("events").select("id, title, starts_at, ends_at, all_day, timezone, location, confidence, evidence_quote, source_message_id")
        .eq("feed_id", id.data).eq("published", false).eq("status", "tentative").order("starts_at").limit(50),
      // Repeating events (imports) carry their coming dates; they stay listed after their first date.
      sb.from("events").select("id, title, starts_at, all_day, timezone, location, status, occurrences")
        .eq("feed_id", id.data).eq("published", true).or(`starts_at.gte.${since},occurrences.neq.{}`).order("starts_at").limit(200),
    ]);
    const upcoming = (listed ?? []).flatMap((e) => {
      const next = Date.parse(e.starts_at) >= Date.parse(since) ? e.starts_at : nextOccurrence(e.occurrences, new Date());
      return next ? [{ ...e, starts_at: next }] : [];
    }).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)).slice(0, 50);
    const list = cands ?? [];
    // D81: the page is grouped by the email things came from. Recent emails, plus any older one
    // that still has something waiting.
    const draftIds = (drafts ?? []).map((d) => d.id);
    const [{ data: recent }, { data: draftWhy }] = await Promise.all([
      sb.from("messages").select("id").eq("feed_id", id.data).gte("received_at", new Date(Date.now() - 14 * 86_400_000).toISOString())
        .order("received_at", { ascending: false }).limit(12),
      draftIds.length ? sb.from("event_candidates").select("event_id, review_reasons, from_transcription, confidence").in("event_id", draftIds).eq("outcome", "new")
        : Promise.resolve({ data: [] as { event_id: string | null; review_reasons: string[] | null; from_transcription: boolean; confidence: number }[] }),
    ]);
    const msgIds = [...new Set([...list.map((x) => x.message_id), ...(drafts ?? []).flatMap((d) => (d.source_message_id ? [d.source_message_id] : [])), ...(recent ?? []).map((m) => m.id)])];
    const evIds = [...new Set(list.flatMap((x) => (x.event_id ? [x.event_id] : [])))];
    const attIds = [...new Set(list.flatMap((x) => (x.attachment_id ? [x.attachment_id] : [])))];
    type Msg = { id: string; clean_text: string | null; original_subject: string | null; subject: string | null; original_sender: string | null; sender: string | null; received_at: string; reference_date: string | null; extraction: unknown };
    type Added = { id: string; title: string; starts_at: string; ends_at: string | null; all_day: boolean; timezone: string; location: string | null; status: string; source_message_id: string | null };
    const [{ data: msgs }, { data: added }, { data: existing }, { data: atts }, { data: pages }] = await Promise.all([
      msgIds.length ? sb.from("messages").select("id, clean_text, original_subject, subject, original_sender, sender, received_at, reference_date, extraction").in("id", msgIds) : Promise.resolve({ data: [] as Msg[] }),
      msgIds.length ? sb.from("events").select("id, title, starts_at, ends_at, all_day, timezone, location, status, source_message_id")
        .eq("feed_id", id.data).eq("published", true).neq("status", "cancelled").in("source_message_id", msgIds).order("starts_at").limit(200) : Promise.resolve({ data: [] as Added[] }),
      evIds.length ? sb.from("events").select("id, title, starts_at, all_day, timezone").in("id", evIds) : Promise.resolve({ data: [] as { id: string; title: string; starts_at: string; all_day: boolean; timezone: string }[] }),
      attIds.length ? sb.from("attachments").select("id, filename, mime, storage_path").in("id", attIds) : Promise.resolve({ data: [] as { id: string; filename: string | null; mime: string | null; storage_path: string | null }[] }),
      attIds.length ? sb.from("attachment_pages").select("attachment_id, page_index, text").in("attachment_id", attIds) : Promise.resolve({ data: [] as { attachment_id: string; page_index: number; text: string | null }[] }),
    ]);
    // Signed URLs: the image itself for photos (always shown when the quote came from one), the file otherwise.
    const paths = (atts ?? []).flatMap((a) => (a.storage_path ? [a.storage_path] : []));
    const signed = new Map<string, string>();
    if (paths.length) {
      const { data } = await sb.storage.from("attachments").createSignedUrls(paths, 600);
      for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
    }
    const cards: ReviewCard[] = list.map((x) => {
      const att = (atts ?? []).find((a) => a.id === x.attachment_id);
      const page = (pages ?? []).find((p) => p.attachment_id === x.attachment_id && p.page_index === x.page_index);
      const msg = (msgs ?? []).find((m) => m.id === x.message_id);
      const ev = (existing ?? []).find((e) => e.id === x.event_id);
      const isImage = Boolean(att && IMAGE.test(att.mime ?? ""));
      const url = att?.storage_path ? signed.get(att.storage_path) ?? null : null;
      const l = local(x.starts_at, x.timezone);
      return {
        id: x.id, messageId: x.message_id, fromPicture: x.from_transcription,
        title: x.title, when: { starts_at: x.starts_at, all_day: x.all_day, timezone: x.timezone }, location: x.location,
        confidence: Number(x.confidence), outcome: x.outcome, changeKind: x.change_kind, reviewReasons: x.review_reasons ?? [],
        existing: ev ? { title: ev.title, starts_at: ev.starts_at, all_day: ev.all_day, timezone: ev.timezone } : null,
        evidence: {
          ...snippet(x.source_kind === "page" ? page?.text ?? null : msg?.clean_text ?? null, x.evidence_quote),
          where: x.source_kind === "page" ? `${att?.filename ?? "attachment"}, page ${(x.page_index ?? 0) + 1}${x.from_transcription ? " (read from an image)" : ""}` : `email: ${msg?.original_subject ?? "(no subject)"}`,
        },
        imageUrl: isImage ? url : null,
        originalUrl: !isImage && x.from_transcription ? url : null,
        date: l.date, time: l.time,
      };
    });
    const draftCards: DraftCard[] = (drafts ?? []).map((d) => {
      const why = (draftWhy ?? []).find((w) => w.event_id === d.id);
      return {
        id: d.id, messageId: d.source_message_id, title: d.title, when: { starts_at: d.starts_at, ends_at: d.ends_at, all_day: d.all_day, timezone: d.timezone },
        location: d.location, confidence: d.confidence === null ? null : Number(d.confidence), quote: d.evidence_quote,
        reviewReasons: why?.review_reasons ?? [], fromPicture: why?.from_transcription ?? false,
      };
    });
    const emails: EmailGroup[] = ((msgs ?? []) as Msg[])
      .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at))
      .map((m) => ({
        id: m.id, subject: m.original_subject ?? m.subject ?? "(no subject)", sender: m.original_sender ?? m.sender ?? null,
        // D85: the day the email was sent, in the calendar's zone. It is the day "this Friday" is counted from.
        received: `${m.reference_date ? "Sent " : ""}${new Intl.DateTimeFormat("en-US", { timeZone: feed.timezone ?? "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" }).format(new Date(m.reference_date ?? m.received_at))}`,
        added: ((added ?? []) as Added[]).filter((e) => e.source_message_id === m.id && Date.parse(e.ends_at ?? e.starts_at) >= Date.parse(since))
          .map((e) => ({ id: e.id, title: e.title, when: { starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day, timezone: e.timezone }, location: e.location, status: e.status })),
        leftOut: leftOutOf(m.extraction, feed.timezone ?? "America/Los_Angeles"),
      }));
    // D88: followers' questions that have no answer yet.
    const { data: asked } = await sb.from("event_questions").select("id, body, created_at, event_id").eq("feed_id", feed.id).eq("status", "open").order("created_at").limit(30);
    const askedIds = [...new Set((asked ?? []).map((q) => q.event_id))];
    const { data: askedEvents } = askedIds.length ? await sb.from("events").select("id, title, starts_at, ends_at, all_day, timezone").in("id", askedIds) : { data: [] };
    const tz = feed.timezone ?? "America/Los_Angeles";
    const questions = (asked ?? []).flatMap((q) => {
      const e = (askedEvents ?? []).find((x) => x.id === q.event_id);
      return e ? [{ id: q.id, body: q.body, eventId: e.id, eventTitle: e.title, when: { starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day, timezone: e.timezone },
        asked: new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(q.created_at)) }] : [];
    });
    return c.html(feedHomePage({
      questions,
      csrf: csrfToken(c), feedId: feed.id, name: feed.name, cards, drafts: draftCards, emails,
      bar: feed.auto_publish_threshold === null ? 0.45 : Number(feed.auto_publish_threshold),
      upcoming: upcoming.map((e) => ({ id: e.id, title: e.title, when: { starts_at: e.starts_at, all_day: e.all_day, timezone: e.timezone }, location: e.location, status: e.status })),
      done: doneOf(c), undo: undoOf(c, `/feeds/${feed.id}`),
    }));
  });

  // One helper for the review POSTs: guard, run the RPC, redirect (PRG). Already-decided → back quietly.
  const act = (path: string, run: (c: Context<AppEnv>, form: Record<string, string>, ids: { feed: string; item: string }) => PromiseLike<{ error: unknown; data?: unknown }>, done: string, withUndo = false) => {
    app.post(path, async (c) => {
      const feed = Id.safeParse(c.req.param("id"));
      const item = Id.safeParse(c.req.param("item") ?? c.req.param("id"));
      if (!feed.success || !item.success) return notFound(c);
      const form = await body(c);
      const user = await guard(c, form);
      if (user instanceof Response) return user;
      const { data, error } = await run(c, form, { feed: feed.data, item: item.data });
      if (error) return c.redirect(`/feeds/${feed.data}`, 303);
      c.get("log").info("review_action", { feed_id: feed.data, action: done });
      const undo = withUndo && typeof data === "string" ? `&undo=${data}` : "";
      return c.redirect(`/feeds/${feed.data}?done=${done}${undo}`, 303);
    });
  };

  act("/feeds/:id/candidates/:item/approve", async (c, f, ids) => {
    const edits = f.date || f.title || f.time || f.location !== undefined
      ? { ...(f.title ? { title: f.title } : {}), ...(f.date ? { date: f.date, time: f.time ?? "" } : {}), ...(f.location !== undefined ? { location: f.location } : {}) }
      : null;
    return c.get("supabase").rpc("approve_candidate", { p_candidate_id: ids.item, ...(edits && Object.keys(edits).length ? { p_edits: edits } : {}) });
  }, "approved");
  act("/feeds/:id/candidates/:item/reject", (c, f, ids) =>
    c.get("supabase").rpc("reject_candidate", { p_candidate_id: ids.item, p_reason: f.reason && f.reason in REJECT_REASONS ? f.reason : "other", ...(f.note ? { p_note: f.note.slice(0, 500) } : {}) }), "rejected", true);
  act("/feeds/:id/drafts/:item/publish", (c, _f, ids) => c.get("supabase").rpc("publish_draft", { p_event_id: ids.item }), "published");
  act("/feeds/:id/drafts/:item/discard", (c, _f, ids) => c.get("supabase").rpc("discard_draft", { p_event_id: ids.item }), "discarded", true);
  // D85: "Add all" on one email's card. Each id goes through the same call as its own button, one
  // at a time, so the owner checks and the audit trail are the same. One that fails is skipped.
  act("/feeds/:id/add-all", async (c, f) => {
    const ids = (s: string | undefined) => (s ?? "").split(",").map((x) => Id.safeParse(x.trim())).flatMap((r) => (r.success ? [r.data] : [])).slice(0, 30);
    const sb = c.get("supabase");
    for (const id of ids(f.candidates)) await sb.rpc("approve_candidate", { p_candidate_id: id });
    for (const id of ids(f.drafts)) await sb.rpc("publish_draft", { p_event_id: id });
    return { error: null };
  }, "added_all");
  // D88: answer or hide a follower's question. The functions check that the user runs the calendar.
  act("/feeds/:id/questions/:item/answer", (c, f, ids) => c.get("supabase").rpc("answer_question", { p_question_id: ids.item, p_answer: (f.answer ?? "").slice(0, 1000) }), "answered");
  act("/feeds/:id/questions/:item/hide", (c, _f, ids) => c.get("supabase").rpc("hide_question", { p_question_id: ids.item }), "question_hidden");
  act("/feeds/:id/approve-sure", (c, _f, ids) => c.get("supabase").rpc("approve_all_sure", { p_feed_id: ids.feed }), "sure");

  // ---------------------------------------------------------------- events
  const EventForm = z.object({
    title: z.string().trim().min(1).max(300), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^(\d{2}:\d{2})?$/).default(""),
    end_date: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default(""), end_time: z.string().regex(/^(\d{2}:\d{2})?$/).default(""),
    all_day: z.string().optional(), location: z.string().max(500).default(""), description: z.string().max(8000).default(""),
  });
  const empty = { title: "", date: "", time: "", end_date: "", end_time: "", all_day: false, location: "", description: "" };

  async function renderEvent(c: Context<AppEnv>, feedId: string, eventId: string | null, extra: { error?: string; values?: typeof empty; status?: 400 } = {}) {
    const feed = await loadFeed(c, feedId);
    if (!feed) return notFound(c);
    let values = extra.values ?? empty;
    let status: string | undefined;
    let quote: string | null = null;
    let history: { at: string; cause: string; actor: string }[] = [];
    if (eventId) {
      const sb = c.get("supabase");
      const { data: e } = await sb.from("events").select("id, title, starts_at, ends_at, all_day, timezone, location, description, status, evidence_quote").eq("id", eventId).eq("feed_id", feedId).maybeSingle();
      if (!e) return notFound(c);
      const s = local(e.starts_at, e.timezone);
      const en = e.ends_at ? local(e.ends_at, e.timezone) : { date: "", time: "" };
      if (!extra.values) values = { title: e.title, date: s.date, time: e.all_day ? "" : s.time, end_date: en.date === s.date ? "" : en.date, end_time: e.all_day ? "" : en.time, all_day: e.all_day, location: e.location ?? "", description: e.description ?? "" };
      status = e.status;
      quote = e.evidence_quote;
      const { data: revs } = await sb.from("event_revisions").select("created_at, cause, actor").eq("event_id", eventId).order("id", { ascending: false }).limit(30);
      history = (revs ?? []).map((r) => ({ at: r.created_at, cause: r.cause, actor: r.actor }));
    }
    return c.html(eventEditPage({ csrf: csrfToken(c), feedId, eventId, timezone: feed.timezone, values, ...(status ? { status } : {}), quote, history,
      ...(extra.error ? { error: extra.error } : {}), done: doneOf(c), undo: undoOf(c, eventId ? `/feeds/${feedId}/events/${eventId}` : `/feeds/${feedId}`) }), extra.status ?? 200);
  }

  app.get("/feeds/:id/events/new", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const user = await guard(c);
    if (user instanceof Response) return user;
    return renderEvent(c, id.data, null);
  });
  app.get("/feeds/:id/events/:eid", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    const eid = Id.safeParse(c.req.param("eid"));
    if (!id.success || !eid.success) return notFound(c);
    const user = await guard(c);
    if (user instanceof Response) return user;
    return renderEvent(c, id.data, eid.data);
  });

  const saveEvent = async (c: Context<AppEnv>, eventId: string | null) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const form = await body(c);
    const user = await guard(c, form);
    if (user instanceof Response) return user;
    const parsed = EventForm.safeParse(form);
    const values = { ...empty, ...form, all_day: form.all_day === "1" };
    if (!parsed.success) return renderEvent(c, id.data, eventId, { error: "Please give the event a title and a date.", values, status: 400 });
    const { data, error } = await c.get("supabase").rpc("save_event", { p_feed_id: id.data, p_event_id: eventId, p_fields: { ...parsed.data, all_day: parsed.data.all_day === "1" } } as never);
    if (error) {
      const msg = (error as { code?: string; message?: string }).code === "22023" ? (error as { message: string }).message : "We couldn't save the event. Please try again.";
      return renderEvent(c, id.data, eventId, { error: msg, values, status: 400 });
    }
    return c.redirect(`/feeds/${id.data}/events/${String(data ?? eventId)}?done=saved`, 303);
  };
  app.post("/feeds/:id/events", (c) => saveEvent(c, null));
  app.post("/feeds/:id/events/:eid", (c) => {
    const eid = Id.safeParse(c.req.param("eid"));
    return eid.success ? saveEvent(c, eid.data) : notFound(c);
  });
  app.post("/feeds/:id/events/:eid/cancel", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    const eid = Id.safeParse(c.req.param("eid"));
    if (!id.success || !eid.success) return notFound(c);
    const form = await body(c);
    const user = await guard(c, form);
    if (user instanceof Response) return user;
    const { data, error } = await c.get("supabase").rpc("cancel_event", { p_event_id: eid.data });
    if (error) return notFound(c);
    return c.redirect(`/feeds/${id.data}/events/${eid.data}?done=cancelled&undo=${String(data)}`, 303);
  });

  // ---------------------------------------------------------------- settings
  async function renderSettings(c: Context<AppEnv>, feedId: string, user: SessionUser, error?: string) {
    const feed = await loadFeed(c, feedId);
    if (!feed) return notFound(c);
    const sb = c.get("supabase");
    const [{ data: editors }, { data: sources }, { data: zipFound }, { data: importRaw }] = await Promise.all([
      sb.from("feed_editors").select("user_id, role").eq("feed_id", feedId),
      sb.from("sources").select("id, sender_email, trusted, blocked, attachment_rule").eq("feed_id", feedId).order("created_at"),
      // D44: a ZIP found in this calendar's addresses (owner only; editors get an error and no suggestion).
      feed.owner_id === user.id && !feed.zip_code ? sb.rpc("feed_zip_suggestion", { p_feed_id: feedId }) : Promise.resolve({ data: null }),
      sb.rpc("feed_import_status", { p_feed_id: feedId }), // D48
    ]);
    const imported = ImportStatus.safeParse(importRaw);
    const suggestion = z.object({ zip: z.string().regex(/^\d{5}$/), places: z.number() }).safeParse(zipFound);
    const { data: profiles } = await sb.from("profiles").select("id, display_name").in("id", (editors ?? []).map((e) => e.user_id));
    return c.html(settingsPage({
      csrf: csrfToken(c), feedId, ...(error ? { error } : {}), done: doneOf(c), undo: undoOf(c, `/feeds/${feedId}/settings`),
      s: {
        name: feed.name, description: feed.description ?? "", visibility: feed.visibility, timezone: feed.timezone,
        threshold: feed.auto_publish_threshold === null ? 0.45 : Number(feed.auto_publish_threshold), isOwner: feed.owner_id === user.id,
        zip: feed.zip_code ?? null, zipSuggestion: suggestion.success ? suggestion.data : null,
        imported: imported.success ? imported.data : null, importNotice: importNotice(c.req.query("import")) ?? null,
        editors: (editors ?? []).map((e) => ({ userId: e.user_id, role: e.role, label: e.user_id === user.id ? "You" : (profiles ?? []).find((p) => p.id === e.user_id)?.display_name ?? "An editor" })),
        senders: (sources ?? []).filter((x) => x.sender_email).map((x) => {
          const rule = x.attachment_rule as { prefer?: unknown[]; never?: unknown[]; allowLarge?: boolean } | null;
          const bits = [rule?.prefer?.length ? "picks a learned file" : "", rule?.never?.length ? `skips ${rule.never.length} kind${rule.never.length === 1 ? "" : "s"} of file` : "", rule?.allowLarge ? "reads big files" : ""].filter(Boolean);
          return { id: x.id, email: x.sender_email ?? "", trusted: x.trusted, blocked: x.blocked, rule: bits.length ? bits.join(", ") : null };
        }),
      },
    }), error ? 400 : 200);
  }

  app.get("/feeds/:id/settings", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const user = await guard(c);
    if (user instanceof Response) return user;
    return renderSettings(c, id.data, user);
  });

  app.post("/feeds/:id/settings", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const form = await body(c);
    const user = await guard(c, form);
    if (user instanceof Response) return user;
    const parsed = z.object({
      name: z.string().trim().min(1).max(120), description: z.string().max(2000).default(""),
      visibility: z.enum(["public", "unlisted", "private"]), timezone: z.string().regex(/^[A-Za-z]+(\/[A-Za-z0-9_+-]+){0,2}$/),
      threshold: z.coerce.number().min(0).max(1),
      zip_code: z.string().trim().regex(/^(\d{5})?$/).default(""),
    }).safeParse(form);
    if (!parsed.success) return renderSettings(c, id.data, user, "Please check the name, time zone and ZIP code (5 digits).");
    if (parsed.data.zip_code && !(await knownZip(c, parsed.data.zip_code))) {
      return renderSettings(c, id.data, user, `We don't know the ZIP code ${parsed.data.zip_code}. Check it, or leave it blank.`);
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone });
    } catch {
      return renderSettings(c, id.data, user, "That time zone isn't recognised. Use a name like America/Los_Angeles.");
    }
    const { error } = await c.get("supabase").from("feeds").update({
      name: parsed.data.name, description: parsed.data.description || null, visibility: parsed.data.visibility,
      timezone: parsed.data.timezone, auto_publish_threshold: parsed.data.threshold, zip_code: parsed.data.zip_code || null,
    } as never).eq("id", id.data);
    if (error) {
      const msg = (error as { message?: string }).message ?? "";
      const listingRule = /^(Public listing|A feed needs|This feed is waiting)/.test(msg);
      return renderSettings(c, id.data, user, listingRule
        ? msg.replace('share it with "anyone with the link"', "keep it Private (its link and QR code still work)")
        : "Only the owner can change these settings.");
    }
    return c.redirect(`/feeds/${id.data}/settings?done=settings`, 303);
  });

  const settingsAction = (path: string, run: (c: Context<AppEnv>, form: Record<string, string>, feed: string, item: string) => PromiseLike<{ data: unknown; error: unknown }>, done: (data: unknown) => string) => {
    app.post(path, async (c) => {
      const feed = Id.safeParse(c.req.param("id"));
      const item = Id.safeParse(c.req.param("item") ?? c.req.param("id"));
      if (!feed.success || !item.success) return notFound(c);
      const form = await body(c);
      const user = await guard(c, form);
      if (user instanceof Response) return user;
      const { data, error } = await run(c, form, feed.data, item.data);
      if (error) return notFound(c);
      return c.redirect(`/feeds/${feed.data}/settings?done=${done(data)}`, 303);
    });
  };
  settingsAction("/feeds/:id/editors", (c, f, feed) => c.get("supabase").rpc("add_editor", { p_feed_id: feed, p_email: (f.email ?? "").slice(0, 320) }),
    (d) => (d === "added" ? "editor_added" : "editor_not_found"));
  settingsAction("/feeds/:id/editors/:item/remove", async (c, _f, feed, item) => {
    const { error } = await c.get("supabase").from("feed_editors").delete().eq("feed_id", feed).eq("user_id", item).eq("role", "editor");
    return { data: null, error };
  }, () => "editor_removed");
  settingsAction("/feeds/:id/sources/:item/clear-rule", (c, _f, _feed, item) => c.get("supabase").rpc("clear_attachment_rule", { p_source_id: item }), () => "rule_cleared");

  app.post("/feeds/:id/delete", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const form = await body(c);
    const user = await guard(c, form);
    if (user instanceof Response) return user;
    if (form.confirm !== "yes") return renderSettings(c, id.data, user, "Please tick the box to confirm.");
    const { data, error } = await c.get("supabase").rpc("request_feed_deletion", { p_feed_id: id.data });
    if (error) return renderSettings(c, id.data, user, "Only the owner can delete this calendar.");
    c.get("log").info("feed_deletion_requested", { feed_id: id.data });
    return c.redirect(`/feeds?done=deleted&undo=${String(data)}`, 303);
  });

  // ---------------------------------------------------------------- undo
  app.post("/undo/:id", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const form = await body(c);
    const user = await guard(c, form);
    if (user instanceof Response) return user;
    const back = form.back && /^\/feeds(\/[0-9a-f-]{36}(\/(settings|events\/[0-9a-f-]{36}))?)?$/.test(form.back) ? form.back : "/feeds";
    const { error } = await c.get("supabase").rpc("undo", { p_undo_id: id.data });
    const tooLate = (error as { code?: string } | null)?.code === "P0001";
    return c.redirect(`${back}?done=${error ? (tooLate ? "too_late" : "undone") : "undone"}`, 303);
  });
}
