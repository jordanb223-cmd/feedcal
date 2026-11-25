// The big Private / Public choice for a calendar (asked for by the owner, 2026-11-21).
//   Private: only people with the link or QR code can see it and subscribe ("unlisted").
//   Public:  the same link and QR, and it can also show up in Find a calendar search.
// Calendars created earlier as "private" (no subscribe page) keep that value until changed.
// D44: Public also shows the calendar's area (ZIP), filled in from a ZIP found in its emails and
// event places when there is one. Private calendars are never asked.
import { html } from "hono/html";

/** The word people see: "unlisted" and the older "private" are both shown as Private. */
export const visibilityLabel = (v: string) => (v === "public" ? "Public" : "Private");

export interface AreaChoice {
  zip: string | null;                                       // what's saved now
  suggestion?: { zip: string; places: number } | null;      // found in emails/events (feed_zip_suggestion)
}

export function visibilityChoice(current: string | undefined, area: AreaChoice = { zip: null }): ReturnType<typeof html> {
  const isPublic = current === "public";
  const privateValue = current === "private" ? "private" : "unlisted";
  const found = !area.zip && area.suggestion ? area.suggestion : null;
  const value = area.zip ?? found?.zip ?? "";
  const hint = area.zip
    ? "Shown in Find a calendar so people nearby can find it."
    : found
      ? `Found in ${found.places} ${found.places === 1 ? "address" : "addresses"} in this calendar's emails and events. Change it if that's not right.`
      : "Optional. Lets people nearby find it. Bumpdraft fills this in when an email includes an address.";
  return html`<fieldset class="choice">
  <legend>Who can find it</legend>
  <label><input type="radio" name="visibility" value="${privateValue}" ${isPublic ? "" : "checked"}>
    <span><strong>Private</strong><br>Only people with the link or QR code can see and subscribe.</span></label>
  <label><input type="radio" name="visibility" value="public" ${isPublic ? "checked" : ""}>
    <span><strong>Public</strong><br>Same link and QR code, and it can show up in <a href="/directory">Find a calendar</a> search.</span></label>
</fieldset>
<div class="area">
  <p><label for="zip_code">Area (ZIP code), for Public calendars</label>
    <input class="copy" id="zip_code" name="zip_code" inputmode="numeric" autocomplete="off" spellcheck="false" pattern="[0-9]{5}" maxlength="5" value="${value}" placeholder="5 digits"></p>
  <p class="muted" style="font-size:.875rem">${hint}</p>
  <p class="muted" style="font-size:.875rem"><strong>Public means anyone can find it and see every event, and its area is shown.</strong> Don't include children's names, home addresses or phone numbers.</p>
</div>
<p class="muted" style="font-size:.875rem">Public listing opens 7 days after you join, and needs at least one published event. School and youth calendars start private to protect children's details. You can change this any time.</p>`;
}
