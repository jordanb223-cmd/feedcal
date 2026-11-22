// D55: the home page for visitors who aren't signed in. Signed-in organizers still go straight to
// their account. Plain and honest: what Calantern does, three steps, and what a parent does with a
// flyer. No numbers or quotes that aren't real.
import { html } from "hono/html";
import { publicLayout } from "./views.js";

export function landingPage() {
  return publicLayout(
    "Your class calendar, lit up",
    html`<section class="hero">
  <span class="kicker">Free for schools, teams and clubs</span>
  <h1>Your class calendar, lit up.</h1>
  <p class="lead">Calantern turns the emails you already get into a calendar families can add to their phones. It keeps itself up to date.</p>
  <p><a class="button wide" href="/login?next=/feeds/new">Make a calendar</a></p>
  <p><a class="button secondary wide" href="/directory">Find a calendar</a></p>
  <p class="muted" style="text-align:center;font-size:.9375rem">Already have one? <a href="/login">Sign in</a></p>
</section>
<section class="card">
  <h2>How it works</h2>
  <ol class="how">
    <li><span class="n" aria-hidden="true">1</span><span><strong>Name it.</strong> "Room F", "Hawks U10", "Choir".</span></li>
    <li><span class="n" aria-hidden="true">2</span><span><strong>Connect your email.</strong> Pick one example email from the school or coach, and Calantern reads only that sender. Or forward emails to it.</span></li>
    <li><span class="n" aria-hidden="true">3</span><span><strong>Print the QR code.</strong> Families scan it and tap Add to Calendar. New events show up on their own.</span></li>
  </ol>
</section>
<section class="card">
  <h2>Got a flyer?</h2>
  <p>Point your phone's camera at the code, tap the link, then tap <strong>Add to Calendar</strong>. No app, no sign-up.</p>
</section>
<p class="assure-line">Works with iPhone, Android, Google Calendar and Outlook. Free, no ads, and we don't sell data.</p>`,
    html`<meta name="description" content="Calantern turns school and team emails into a calendar families add to their phones. Free.">`,
  );
}
