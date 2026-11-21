# Changelog

What changed in Feedcal, written for the people who run calendars with it. Newest first.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

A production release is a tag `vX.Y.Z`. The deploy refuses to run unless this file has a `## [X.Y.Z]` section.

## [Unreleased]

### Added
- A page for each calendar that families can open from a text or a group chat, with a one-tap subscribe button for their phone.
- A share kit: the page link, a QR code, a ready-to-paste message and a printable flyer.
- "Make a new link", for when a calendar link was shared too widely.
- Clear status labels for events, emails and reports.
- Each calendar has its own email address. Forward school or team emails to it (setup steps for Gmail, Outlook and Apple Mail are on the page).
- Gmail's forwarding confirmation appears on the calendar's email page as a button, so you can finish setup without hunting for the email.
- The first email from a new sender waits for your OK. Emails that fail the sender's security checks are held for you too.
- Feedcal now reads forwarded emails: it finds the original sender and date inside Gmail, Outlook and Apple Mail forwards, ignores quoted replies and signatures, keeps tables readable, and sets aside logos and social-media icons.
- Feedcal picks the pages worth reading from attached PDFs (at most 5 per email), and skips receipts, files it has already read, and very large files.
- Under "Recent emails" you can see what Feedcal read from each attachment and tap "This one has the schedule" or "Never use files like this". It remembers your choice for that sender's next emails.
- Feedcal can find the events in an email and its attachments, once an AI key is set. Every event must quote the sentence it came from, times are never guessed, and emails that try to give the AI instructions are held for you to check.
- When a school or coach sends a change (a new time, a new date, a cancellation), the event updates in everyone's calendar instead of appearing twice. A cancelled single practice disappears from a weekly series. Feedcal never deletes an event on its own.
- A dashboard for your feeds, and a review screen made for phones: see what Feedcal found with the sentence it came from highlighted, then approve, edit, or reject it. "Approve all marked Sure" handles the easy ones. Add and edit events by hand, with each event's history.
- Settings for each feed: name, who can find it, time zone, how sure Feedcal must be to publish on its own, trusted senders, editors, and delete (with 10 seconds to undo).
- Fixed: creating a new feed failed for signed-in users.
- Forwarding the same email twice is harmless; Feedcal keeps one copy and deletes copies after 30 days.

### Fixed
- Edits to an event now reach calendars that already subscribed. Before, some calendar apps could ignore an edit.
- A typo in your email on the sign-in page no longer clears what you typed.
- If something breaks, you now see a plain page with a code to quote, not raw technical text.

### Security
- Sign-in emails are limited to 5 per address and 20 per network each hour.
- Problems can be reported privately; see SECURITY.md.
