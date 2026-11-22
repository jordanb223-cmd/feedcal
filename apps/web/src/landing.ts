// D55: the home page for visitors who aren't signed in. Signed-in organizers still go straight to
// their account. Plain and honest: what Calantern does, three steps, and what a parent does with a
// flyer. No numbers or quotes that aren't real.
import { html } from "hono/html";
import { publicLayout } from "./views.js";

export const HOME_DESCRIPTION = "Calantern reads the school, team and club emails you already get and adds every event to your calendar, so you never add them one by one. Free.";
const DEFAULT_HEAD = html`<meta name="description" content="${HOME_DESCRIPTION}">`;

export function landingPage(head: ReturnType<typeof html> | string = DEFAULT_HEAD) {
  return publicLayout(
    "Events that add themselves",
    html`<section class="hero">
  <span class="kicker">Free for you, your family and friends</span>
  <h1>Events that add themselves.</h1>
  <p class="lead">Stop adding events one by one. Calantern reads the emails you already get from school, the team or the club, and keeps putting every new event on your calendar. Share it, and your friends and family stay up to date too.</p>
  <p><a class="button wide" href="/login?next=/feeds/new">Make a calendar</a></p>
  <p><a class="button secondary wide" href="/directory">Find a calendar</a></p>
  <p class="muted" style="text-align:center;font-size:.9375rem">Already have one? <a href="/login">Sign in</a></p>
</section>
<section class="card">
  <h2>How it works</h2>
  <ol class="how">
    <li><span class="n" aria-hidden="true">1</span><span><strong>Name it.</strong> "Room F", "Hawks U10", "Choir".</span></li>
    <li><span class="n" aria-hidden="true">2</span><span><strong>Connect your email.</strong> Pick one example email from the school or coach, and Calantern reads only that sender. Or forward emails to it.</span></li>
    <li><span class="n" aria-hidden="true">3</span><span><strong>Share it.</strong> Add it to your own phone, or send the link or print the QR code for friends and family. New events show up on their own.</span></li>
  </ol>
</section>
<section class="card">
  <h2>Got a flyer?</h2>
  <p>Point your phone's camera at the code, tap the link, then tap <strong>Add to Calendar</strong>. No app, no sign-up.</p>
</section>
<p class="assure-line">Works with iPhone, Android, Google Calendar and Outlook. Free, no ads, and we don't sell data.</p>`,
    head,
  );
}
