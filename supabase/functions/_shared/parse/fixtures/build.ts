// Builds the Phase 7 fixture emails. All people, schools and addresses are invented
// (example.test never delivers). Deterministic: rerunning gives byte-identical files.
//   deno run --allow-write=supabase/functions/_shared/parse/fixtures supabase/functions/_shared/parse/fixtures/build.ts
const DIR = new URL("./", import.meta.url);
const enc = new TextEncoder();

// ---------------------------------------------------------------- byte helpers
let seed = 42;
function filler(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; out[i] = seed >>> 24; }
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16 = (n: number) => new Uint8Array([(n >>> 8) & 255, n & 255]);

/** A PNG header declaring w×h, padded to `size` bytes (headers are what the parser reads). */
function png(w: number, h: number, size: number): Uint8Array {
  const head = concat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), enc.encode("IHDR"), u32(w), u32(h), new Uint8Array([8, 2, 0, 0, 0]), u32(0));
  const tail = concat(u32(0), enc.encode("IEND"), u32(0xae426082));
  return concat(head, filler(Math.max(0, size - head.length - tail.length)), tail);
}
function jpeg(w: number, h: number, size: number): Uint8Array {
  const app0 = concat(new Uint8Array([0xff, 0xe0]), u16(16), enc.encode("JFIF\0"), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const sof = concat(new Uint8Array([0xff, 0xc0]), u16(17), new Uint8Array([8]), u16(h), u16(w), new Uint8Array([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  const head = concat(new Uint8Array([0xff, 0xd8]), app0, sof);
  return concat(head, filler(Math.max(0, size - head.length - 2)), new Uint8Array([0xff, 0xd9]));
}
function gif(w: number, h: number): Uint8Array {
  return concat(enc.encode("GIF89a"), new Uint8Array([w & 255, w >> 8, h & 255, h >> 8, 0x80, 0, 0]), filler(30), new Uint8Array([0x3b]));
}
function pdf(size: number, text: string): Uint8Array {
  const head = enc.encode(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\n`);
  return concat(head, filler(Math.max(0, size - head.length - 6)), enc.encode("\n%%EOF"));
}
function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3 * 1024) s += String.fromCharCode(...bytes.subarray(i, i + 3 * 1024));
  return btoa(s).replace(/.{76}/g, "$&\r\n");
}
function qp(text: string): string {
  const bytes = enc.encode(text);
  let line = "";
  const out: string[] = [];
  for (const b of bytes) {
    const ch = b === 0x0a ? "\n" : (b >= 33 && b <= 126 && b !== 61) || b === 32 ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    if (ch === "\n") { out.push(line); line = ""; continue; }
    if (line.length + ch.length > 73) { out.push(line + "="); line = ""; }
    line += ch;
  }
  out.push(line);
  return out.join("\r\n");
}

// ---------------------------------------------------------------- MIME helpers
interface Part { headers: string[]; body: string }
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
const textPart = (text: string, type = "text/plain", charset = "utf-8"): Part => ({ headers: [`Content-Type: ${type}; charset=${charset}`, "Content-Transfer-Encoding: 8bit"], body: crlf(text) });
const qpPart = (text: string, type = "text/html"): Part => ({ headers: [`Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: quoted-printable"], body: qp(text) });
const b64TextPart = (text: string): Part => ({ headers: ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"], body: b64(enc.encode(text)) });
function filePart(name: string, type: string, bytes: Uint8Array, opts: { inline?: boolean; cid?: string } = {}): Part {
  return {
    headers: [
      `Content-Type: ${type}; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: ${opts.inline ? "inline" : "attachment"}; filename="${name}"`,
      ...(opts.cid ? [`Content-ID: <${opts.cid}>`] : []),
    ],
    body: b64(bytes),
  };
}
const messagePart = (raw: string): Part => ({ headers: ["Content-Type: message/rfc822", 'Content-Disposition: attachment; filename="original.eml"'], body: raw });
function multi(kind: string, parts: Part[], boundary: string): Part {
  const body = parts.map((p) => `--${boundary}\r\n${p.headers.join("\r\n")}\r\n\r\n${p.body}\r\n`).join("") + `--${boundary}--`;
  return { headers: [`Content-Type: multipart/${kind}; boundary="${boundary}"`], body };
}
function message(h: { from: string; subject: string; date: string; id: string; to?: string }, part: Part): string {
  return [
    `From: ${h.from}`, `To: ${h.to ?? "Alex Parent <parent@home.example.test>"}`, `Subject: ${h.subject}`, `Date: ${h.date}`,
    `Message-ID: <${h.id}@fixtures.example.test>`, "MIME-Version: 1.0", ...part.headers,
  ].join("\r\n") + "\r\n\r\n" + part.body + "\r\n";
}

const SCHOOL = "Maple Grove Elementary <office@maplegrove.example.test>";
const COACH = "Coach Dana Reyes <dana@riverleague.example.test>";
const PARENT = "Alex Parent <parent@home.example.test>";
const fixtures: Record<string, string> = {};

// ---------------------------------------------------------------- 01–06: everyday senders
fixtures["01-school-newsletter-html"] = message(
  { from: SCHOOL, subject: "Maple Grove News: November", date: "Fri, 14 Nov 2026 15:30:00 -0800", id: "f01" },
  multi("related", [
    multi("alternative", [
      textPart("View this email in your browser: https://maplegrove.example.test/news/nov"),
      textPart(`<html><head><style>.x{color:red}</style><title>News</title></head><body>
<div style="display:none;max-height:0">Preheader: don't miss the book fair</div>
<table width="600"><tr><td><img src="cid:logo@mg" alt="Maple Grove"><h1>November News</h1>
<p>Dear families, here are the dates for the rest of the month.</p>
<table border="1"><tr><th>Date</th><th>Event</th><th>Time</th></tr>
<tr><td>Nov 21</td><td>Picture day</td><td>8:30 AM</td></tr>
<tr><td>Nov 26&ndash;28</td><td>Thanksgiving break, no school</td><td></td></tr></table>
<p>Visit the <a href="https://maplegrove.example.test/bookfair">Book fair</a> in the library all week.</p>
<p><a href="https://social.example.test/maplegrove"><img src="cid:fb@mg" alt="Facebook"></a></p>
</td></tr></table><img src="https://track.example.test/open.gif?u=1" width="1" height="1"></body></html>`, "text/html"),
    ], "alt01").valueOf() as Part,
    filePart("maple-logo.png", "image/png", png(200, 80, 4096), { inline: true, cid: "logo@mg" }),
    filePart("facebook.png", "image/png", png(32, 32, 1200), { inline: true, cid: "fb@mg" }),
  ], "rel01"),
);

fixtures["02-sports-schedule-table"] = message(
  { from: COACH, subject: "U10 Hawks fall schedule", date: "Sun, 12 Oct 2026 19:05:00 -0700", id: "f02" },
  textPart(`<p>Hi Hawks families,</p><p>Here is the rest of the season:</p>
<table><thead><tr><th>Date</th><th>Opponent</th><th>Field</th><th>Kickoff</th></tr></thead>
<tbody><tr><td>Sat Oct 18</td><td>Falcons</td><td>McKinley Park #3</td><td>9:00 AM</td></tr>
<tr><td>Sat Oct 25</td><td>Otters</td><td>Riverside #1</td><td>10:30 AM</td></tr>
<tr><td>Sat Nov 1</td><td>Comets</td><td>McKinley Park #2</td><td>8:00 AM</td></tr></tbody></table>
<p>Arrive 30 minutes early. Questions? <a href="mailto:dana@riverleague.example.test">dana@riverleague.example.test</a></p>`, "text/html"),
);

fixtures["03-appointment-reminder"] = message(
  { from: "Riverside Pediatrics <noreply@riversideped.example.test>", subject: "Appointment reminder", date: "Mon, 24 Nov 2026 10:00:00 -0800", id: "f03" },
  textPart(`Hello,

This is a reminder that Sam has an appointment with Dr. Okafor on Tuesday, December 2 at 3:45 PM at our Elm Street office.

Please arrive 10 minutes early.

--
Riverside Pediatrics
1200 Elm Street, Suite 4
(555) 010-2299`),
);

fixtures["04-venue-list"] = message(
  { from: "Lakeside Swim Club <coach@lakesideswim.example.test>", subject: "Meet locations this winter", date: "Wed, 05 Nov 2026 08:12:00 -0600", id: "f04" },
  textPart(`Winter meets and where they are:

- Sat Dec 6, warm-ups 7:30 AM: Northside Aquatic Center, 400 Pool Rd
- Sat Jan 10, warm-ups 8:00 AM: Westfield High School natatorium
- Sun Feb 8, warm-ups 7:00 AM: University Rec Center (park in Lot C)

Carpool sign-up: https://lakesideswim.example.test/carpool`),
);

fixtures["05-flyer-image-only"] = message(
  { from: "Oak Street PTA <pta@oakstreet.example.test>", subject: "Fall Festival!", date: "Thu, 02 Oct 2026 12:00:00 -0700", id: "f05" },
  multi("mixed", [
    filePart("fall-festival-flyer.jpg", "image/jpeg", jpeg(1200, 1600, 300_000)),
    filePart("pta-logo.png", "image/png", png(180, 180, 9000)),
  ], "mix05"),
);

fixtures["06-pdf-only"] = message(
  { from: SCHOOL, subject: "December calendar", date: "Mon, 01 Dec 2026 07:45:00 -0800", id: "f06" },
  multi("mixed", [textPart("See attached."), filePart("December-calendar.pdf", "application/pdf", pdf(150_000, "December calendar"))], "mix06"),
);

// ---------------------------------------------------------------- 07–12: forwards and replies
fixtures["07-gmail-forward-plain"] = message(
  { from: PARENT, subject: "Fwd: Practice schedule", date: "Tue, 18 Nov 2026 07:02:11 -0800", id: "f07", to: "feed-aliceschoolfeed23456@in.feedcal.test" },
  textPart(`Can you add these?

---------- Forwarded message ---------
From: ${COACH}
Date: Mon, Nov 17, 2026 at 9:14 AM
Subject: Practice schedule
To: Hawks Parents <hawks@riverleague.example.test>

Practices are Tuesdays and Thursdays 5:00-6:15 PM at McKinley Park field 3 starting December 2.
`),
);

fixtures["08-outlook-forward-html"] = message(
  { from: PARENT, subject: "FW: Winter concert", date: "Tue, 18 Nov 2026 08:30:00 -0500", id: "f08" },
  textPart(`<div>Adding this one.</div><hr>
<div id="divRplyFwdMsg"><font face="Calibri"><b>From:</b> Ms. Patel &lt;patel@maplegrove.example.test&gt;<br>
<b>Sent:</b> Monday, November 17, 2026 9:14 AM<br><b>To:</b> Room 12 Families<br><b>Subject:</b> Winter concert</font></div>
<div><p>The winter concert is Thursday, December 11 at 6:30 PM in the gym. Students arrive by 6:00 PM.</p></div>`.replace("<hr>", "<div>________________________________</div>"), "text/html"),
);

fixtures["09-apple-mail-forward"] = message(
  { from: PARENT, subject: "Fwd: Library volunteer shifts", date: "Wed, 19 Nov 2026 21:40:00 -0800", id: "f09" },
  textPart(`FYI

Begin forwarded message:

From: Jordan Lee <library@oakstreet.example.test>
Subject: Library volunteer shifts
Date: November 17, 2026 at 9:14:02 AM PST
To: Volunteers <volunteers@oakstreet.example.test>

Shifts for December: Mondays 1-3 PM and Fridays 9-11 AM in the school library.
`),
);

fixtures["10-forwarded-chain"] = message(
  { from: PARENT, subject: "Fwd: FW: Winter concert schedule", date: "Tue, 18 Nov 2026 07:00:00 -0800", id: "f10" },
  textPart(`For the calendar

---------- Forwarded message ---------
From: Sam Rivera <sam.rivera@home.example.test>
Date: Mon, Nov 17, 2026 at 6:00 PM
Subject: FW: Winter concert schedule
To: ${PARENT}

Sending this along

________________________________
From: Mr. Chen <chen@maplegrove.example.test>
Sent: Sunday, November 16, 2026 8:00 PM
To: Grade 3 Families
Subject: Winter concert schedule

Grade 3 performs at 7:15 PM on December 11. Dress rehearsal is December 10 at 2:00 PM.
`),
);

fixtures["11-reply-changed-time"] = message(
  { from: COACH, subject: "Re: Thursday practice", date: "Wed, 19 Nov 2026 12:00:00 -0800", id: "f11" },
  textPart(`Update: Thursday practice moves to 6:00 PM because of the field lights.

On Mon, Nov 17, 2026 at 9:14 AM Coach Dana Reyes <dana@riverleague.example.test>
wrote:
> Practice is Thursday at 5:00 PM at McKinley Park.
> See you there!
`),
);

const enclosed = message(
  { from: "Ms. Patel <patel@maplegrove.example.test>", subject: "Field trip permission", date: "Mon, 17 Nov 2026 09:14:00 -0800", id: "f12-inner", to: "Room 12 Families <room12@maplegrove.example.test>" },
  multi("mixed", [
    textPart("Our field trip to the science museum is Friday, December 5. Bus leaves at 8:45 AM. Permission slip attached."),
    filePart("permission-slip.pdf", "application/pdf", pdf(60_000, "permission slip")),
  ], "mix12in"),
);
fixtures["12-forward-as-attachment"] = message(
  { from: PARENT, subject: "FW: Field trip permission", date: "Tue, 18 Nov 2026 07:00:00 -0800", id: "f12" },
  multi("mixed", [textPart("FYI"), messagePart(enclosed)], "mix12"),
);

// ---------------------------------------------------------------- 13–17: encodings and languages
fixtures["13-quoted-printable-html"] = message(
  { from: SCHOOL, subject: "Café night", date: "Thu, 06 Nov 2026 16:00:00 -0800", id: "f13" },
  qpPart(`<html><body><table style="width:100%"><tr><td><p style="font-family:Arial,sans-serif;font-size:14px">Join us for Café night on Friday, November 21 from 6:00 to 8:00 PM in the cafeteria. Hot cocoa is $1.</p></td></tr></table></body></html>`),
);

fixtures["14-latin1-french"] = message(
  { from: "École Saint-Michel <secretariat@stmichel.example.test>", subject: "=?ISO-8859-1?Q?R=E9union_des_parents?=", date: "Tue, 04 Nov 2026 09:00:00 +0100", id: "f14" },
  { headers: ["Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable"], body: "R=E9union des parents le mardi 18 novembre =E0 18h30 dans la salle polyvalente.\r\nMerci de confirmer votre pr=E9sence avant vendredi. Nous vous attendons avec les enseignants." },
);

fixtures["15-spanish-newsletter"] = message(
  { from: "Escuela Las Palmas <oficina@laspalmas.example.test>", subject: "Noticias de la semana", date: "Fri, 07 Nov 2026 14:00:00 -0600", id: "f15" },
  textPart(`Estimadas familias:

La feria de ciencias será el jueves 20 de noviembre de las 5:00 a las 7:00 de la tarde en el gimnasio. No habrá clases el viernes 28 de noviembre por el Día de Acción de Gracias.

Gracias por su apoyo.`),
);

fixtures["16-hebrew-rtl"] = message(
  { from: "Beit Sefer <office@beitsefer.example.test>", subject: "=?UTF-8?B?157XodeZ15HXqiDXl9eg15XXm9eU?=", date: "Sun, 07 Dec 2026 10:00:00 +0200", id: "f16" },
  b64TextPart("שלום להורים,\n\nמסיבת חנוכה תתקיים ביום רביעי, 17 בדצמבר, בשעה 17:00 באולם בית הספר. נשמח לראותכם.\n"),
);

fixtures["17-calendar-invite"] = message(
  { from: COACH, subject: "Invitation: End of season party", date: "Mon, 10 Nov 2026 18:00:00 -0800", id: "f17" },
  multi("mixed", [
    textPart("You're invited to the end of season party, Saturday November 22, 4-6 PM at Pizza Planet."),
    filePart("invite.ics", "text/calendar", enc.encode("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:party@riverleague.example.test\r\nDTSTART:20261123T000000Z\r\nDTEND:20261123T020000Z\r\nSUMMARY:End of season party\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")),
  ], "mix17"),
);

// ---------------------------------------------------------------- 18–26: images, noise, edge cases
fixtures["18-inline-photo-kept"] = message(
  { from: "Oak Street PTA <pta@oakstreet.example.test>", subject: "Bake sale this Saturday", date: "Wed, 12 Nov 2026 09:00:00 -0800", id: "f18" },
  multi("related", [
    textPart(`<p>Our bake sale is this Saturday, November 15, 9 AM to noon at the front entrance.</p><p><img src="cid:poster@pta" width="900" height="600"></p><img src="cid:spacer@pta" width="1" height="1">`, "text/html"),
    filePart("bake-sale-poster.jpg", "image/jpeg", jpeg(900, 600, 80_000), { inline: true, cid: "poster@pta" }),
    filePart("spacer.gif", "image/gif", gif(1, 1), { inline: true, cid: "spacer@pta" }),
  ], "rel18"),
);

fixtures["19-tracking-and-hidden"] = message(
  { from: "Rec Department <news@cityrec.example.test>", subject: "Winter registration opens", date: "Mon, 03 Nov 2026 06:00:00 -0800", id: "f19" },
  textPart(`<html><body><span style="display: none !important; mso-hide: all">Secret preheader text</span>
<div hidden>Hidden block</div><script>alert(1)</script>
<p>Winter class registration opens Monday, November 10 at 9:00 AM.</p>
<p><a href="https://cityrec.example.test/register?utm_source=email">Register here</a> or visit <a href="https://cityrec.example.test">https://cityrec.example.test</a>.</p>
<img src="https://pixel.example.test/o.gif" width="1" height="1" alt="">
<p style="font-size:11px"><a href="https://cityrec.example.test/unsubscribe">Unsubscribe</a></p></body></html>`, "text/html"),
);

fixtures["20-mobile-signature"] = message(
  { from: COACH, subject: "Game moved", date: "Sat, 15 Nov 2026 07:10:00 -0800", id: "f20" },
  textPart("Today's game moved to Riverside field 2, same time (10:30 AM).\n\nSent from my iPhone"),
);

fixtures["21-outlook-reply-not-forward"] = message(
  { from: "PTA Chair <chair@oakstreet.example.test>", subject: "RE: Bake sale", date: "Tue, 18 Nov 2026 10:00:00 -0800", id: "f21" },
  textPart(`Yes, we still need 3 volunteers for Saturday 9 AM.

________________________________
From: Alex Parent <parent@home.example.test>
Sent: Monday, November 17, 2026 9:14 AM
Subject: Bake sale

Do you still need help on Saturday at 8 AM?`),
);

const sharedPdf = pdf(40_000, "lunch menu");
fixtures["22-duplicate-attachments"] = message(
  { from: SCHOOL, subject: "Lunch menu", date: "Mon, 01 Dec 2026 08:00:00 -0800", id: "f22" },
  multi("mixed", [textPart("December lunch menu attached."), filePart("lunch-menu.pdf", "application/pdf", sharedPdf), filePart("lunch-menu (1).pdf", "application/pdf", sharedPdf)], "mix22"),
);

fixtures["23-winmail-and-vcard"] = message(
  { from: "Front Office <front@riverside.example.test>", subject: "Conference schedule", date: "Thu, 13 Nov 2026 13:00:00 -0800", id: "f23" },
  multi("mixed", [
    textPart("Parent-teacher conferences are November 24 and 25. Your time slot is in the attached PDF."),
    filePart("winmail.dat", "application/ms-tnef", filler(5000)),
    filePart("Front Office.vcf", "text/vcard", enc.encode("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Front Office\r\nEND:VCARD\r\n")),
    filePart("conference-slots.pdf", "application/pdf", pdf(30_000, "conference slots")),
  ], "mix23"),
);

fixtures["24-base64-text"] = message(
  { from: "Scout Troop 12 <leader@troop12.example.test>", subject: "Camping trip", date: "Fri, 31 Oct 2026 20:00:00 -0700", id: "f24" },
  b64TextPart("The November camping trip is the weekend of November 14-16 at Pine Lake. We leave Friday at 5 PM from the church parking lot.\n"),
);

fixtures["25-html-layout-tables"] = message(
  { from: "Hillside Music School <hello@hillsidemusic.example.test>", subject: "Recital details", date: "Sat, 08 Nov 2026 11:00:00 -0800", id: "f25" },
  textPart(`<table role="presentation" width="100%"><tr><td align="center"><table width="600"><tr><td>
<h2>Winter Recital</h2><p>Sunday, December 14 at 2:00 PM, Hillside Community Hall.</p>
<table><tr><td>Piano students</td><td>2:00 PM</td></tr><tr><td>Violin students</td><td>3:15 PM</td></tr></table>
</td></tr><tr><td><p>Doors open at 1:30 PM.</p></td></tr></table></td></tr></table>`, "text/html"),
);

fixtures["26-outlook-mobile-numeric-date"] = message(
  { from: PARENT, subject: "FW: Field trip forms", date: "Tue, 18 Nov 2026 09:00:00 -0600", id: "f26" },
  textPart(`Please see below

From: Ms. Rivera <rivera@maplegrove.example.test>
Sent: 11/17/2026 9:14 AM
To: Parents
Subject: Field trip forms

Forms are due Friday, November 21. The trip is December 3.`),
);

for (const [name, raw] of Object.entries(fixtures)) {
  await Deno.writeFile(new URL(`${name}.eml`, DIR), enc.encode(raw));
}
console.log(`wrote ${Object.keys(fixtures).length} fixtures`);
