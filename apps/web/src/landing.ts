// D55: the home page for visitors who aren't signed in. Signed-in organizers still go straight to
// their account. Plain and honest: what Bumpdraft does, three steps, and what a parent does with a
// flyer. No numbers or quotes that aren't real.
import { html } from "hono/html";
import { publicLayout } from "./views.js";

export const HOME_DESCRIPTION = "Bumpdraft reads the school, team and club emails you already get and adds every event to your calendar, so you never add them one by one. Free.";
const DEFAULT_HEAD = html`<meta name="description" content="${HOME_DESCRIPTION}">`;

export function landingPage(head: ReturnType<typeof html> | string = DEFAULT_HEAD) {
  return publicLayout(
    "Events that add themselves",
    html`<section class="hero">
  <div class="pitch">
  <h1>Events that <span>add themselves.</span></h1>
  <p class="lead">Keep emailing like you always do. Bumpdraft finds the dates and puts every event on everyone's calendar, yours included, so nobody types anything in.</p>
  <p class="actions"><a class="button" href="/login?next=/feeds/new">Make a calendar</a></p>
  <p class="assure">Free. No app. Works with iPhone, Google Calendar and Outlook. Already have one? <a href="/login">Sign in</a></p>
  </div>
  <div class="demo" aria-label="An example: a line in a school email becomes a calendar event">
    <p class="slip"><small>From: Room F &lt;office@school&gt;</small>Reminder: our pumpkin patch trip is <mark>Wednesday the 25th at 9:00</mark>. Please send a jacket.</p>
    <p class="becomes" aria-hidden="true">↓ becomes</p>
    <ul class="cal"><li class="next"><span class="day" aria-hidden="true"><span class="dow">Wed</span><span class="num">25</span></span><span class="what"><strong>Pumpkin patch field trip</strong><span class="when">Wed, Nov 25 · 9:00 AM</span></span></li></ul>
  </div>
</section>
<section class="card">
  <h2>How it works</h2>
  <ol class="how">
    <li><span class="n" aria-hidden="true">1</span><span><strong>Name it.</strong> "Room F", "Hawks U10", "Choir".</span></li>
    <li><span class="n" aria-hidden="true">2</span><span><strong>Keep emailing like normal.</strong> Sending the emails? Add the calendar's address in CC. Getting them? Connect Gmail, or forward them. Bumpdraft asks you once before it trusts a new sender.</span></li>
    <li><span class="n" aria-hidden="true">3</span><span><strong>Everyone's calendar fills itself.</strong> Share the link or QR code once. From then on, new events appear on their phones, and yours, without anyone typing them in.</span></li>
  </ol>
</section>
<section class="card">
  <h2>Got a flyer?</h2>
  <p>Point your phone's camera at the code, tap the link, then tap <strong>Add to Calendar</strong>. No app, no sign-up.</p>
</section>
<p class="assure-line">No ads, and we don't sell data.</p>`,
    head,
  );
}
