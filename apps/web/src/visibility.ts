// The big Private / Public choice for a calendar (asked for by the owner, 2026-11-21).
//   Private: only people with the link or QR code can see it and subscribe ("unlisted").
//   Public:  the same link and QR, and it can also show up in Find a calendar search.
// Calendars created earlier as "private" (no subscribe page) keep that value until changed.
import { html } from "hono/html";

export function visibilityChoice(current: string | undefined): ReturnType<typeof html> {
  const isPublic = current === "public";
  const privateValue = current === "private" ? "private" : "unlisted";
  return html`<fieldset class="choice">
  <legend>Who can find it</legend>
  <label><input type="radio" name="visibility" value="${privateValue}" ${isPublic ? "" : "checked"}>
    <span><strong>🔒 Private</strong><br>Only people with the link or QR code can see and subscribe.</span></label>
  <label><input type="radio" name="visibility" value="public" ${isPublic ? "checked" : ""}>
    <span><strong>🌐 Public</strong><br>Same link and QR code, and it can show up in <a href="/directory">Find a calendar</a> search.</span></label>
</fieldset>
<p class="muted" style="font-size:.875rem">Public listing opens 7 days after you join, and needs at least one published event. School and youth calendars start private to protect children's details. You can change this any time.</p>`;
}
