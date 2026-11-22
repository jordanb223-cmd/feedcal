# Changelog

What changed in Feedcal, written for the people who run calendars with it. Newest first.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

A production release is a tag `vX.Y.Z`. The deploy refuses to run unless this file has a `## [X.Y.Z]` section.

## [Unreleased]

## [0.8.2] - 2026-11-22

### Added
- A Contact page (linked at the bottom of every page) for bug reports, questions and privacy requests. Add your email if you'd like a reply.

## [0.8.1] - 2026-11-22

### Added
- A short note at the foot of every page: Calantern fills calendars in automatically, can make mistakes, and isn't run by any school or team.
- The privacy page now explains exactly which cookies Calantern uses (only ones it needs, deleted when you close your browser) and that there are no trackers, ads or analytics.

## [0.8.0] - 2026-11-21

### Added
- Upload a newsletter, schedule or flyer to a calendar: PDF, Word (.docx), photos and text files up to 10 MB. Calantern reads the dates the same way it reads emails.
- Word files attached to forwarded emails are now read too.

### Changed
- Files are checked to be what their name says before they're read.

## [0.7.4] - 2026-11-21

### Fixed
- A specially crafted email could stall email processing; it now can't, and a message that keeps failing is set aside instead of retried forever.
- Calendar imports can no longer be pointed at internal network addresses.
- An imported calendar can no longer break your feed for subscribers (unusual characters, extreme dates or "every second" repeats).
- Email subjects always stay on one line.

### Changed
- Bigger tap targets for the top links on phones.
- Better previews when you share Calantern links, and search engines can find the main pages.

## [0.7.3] - 2026-11-21

### Fixed
- An email from a sender you haven't approved can no longer add a location to an event that's already on your calendar.
- A sign-in link with unusual characters now takes you to your account instead of an error page.

### Changed
- Stronger protection against emails written to trick the event reader.

## [0.7.2] - 2026-11-21

### Changed
- Nothing you'll see. Behind the scenes, every update now saves a fresh backup of all calendars first, and changes that would delete data are flagged for review.

## [0.7.1] - 2026-11-21

### Changed
- The home page now leads with what Calantern saves you: events that add themselves, so you stop adding them one by one. It speaks to anyone keeping themselves, friends or family up to date, not only schools and teams.

## [0.7.0] - 2026-11-21

### Changed
- Feedcal is now **Calantern**: the site, emails, flyer and Google sign-in screen use the new name. Existing calendars, links and subscriptions keep working unchanged.

### Added
- A home page for visitors explaining what Calantern does, with Make a calendar and Find a calendar.

## [0.6.6] - 2026-11-21

### Changed
- The printable flyer fills the page with a big QR code, steps that match the button parents will see, and a line saying it works with iPhone, Android, Google Calendar and Outlook.

### Added
- "Two per page" flyers with a cut line, to save paper.

## [0.6.5] - 2026-11-21

### Changed
- The follower count now reads "≈ N" instead of "at least N", with a short note on why it's approximate. Emails say "about".

## [0.6.4] - 2026-11-21

### Fixed
- "At least N calendars follow this" counts only real calendar apps (Apple Calendar, Google Calendar, Outlook). Opening the link in a web browser, or a search engine crawling it, no longer counts as a follower.

## [0.6.3] - 2026-11-21

### Security
- Follower counts and the limits on reports, search and sign-in can no longer be gamed by calling Feedcal's database directly with made-up visitor addresses.
- Disconnecting Gmail revokes Feedcal's access without putting the token in a web address.
- Browsers are told to use HTTPS for Feedcal for a year.
- Copying events from a calendar link refuses links whose name points into a private network.

## [0.6.2] - 2026-11-21

### Changed
- The follower count is shown publicly again ("At least N calendars follow this"), now with the honest count from 0.6.0. Feedcal never knows who follows: no names or emails are collected from subscribers. (0.6.1 hid the count; it was never released.)

## [0.6.1] - 2026-11-21

### Changed
- Follower counts are no longer shown on public calendar pages or in Find a calendar. Organizers still see their own on the Share page and in the weekly email.

## [0.6.0] - 2026-11-21

### Added
- Copy events from a calendar link you already have (like a school's Google Calendar link) into your Feedcal calendar. It's under "More ways to add events" and in Settings. By default Feedcal copies them once and you keep them up to date; you can tick a box to keep checking the link every day.

### Fixed
- "At least N calendars follow this" no longer counts the same phone once per day, or checks that aren't calendar apps. It now shows the busiest single day, so the number is never higher than the truth.

## [0.5.0] - 2026-11-21

### Changed
- Setting up a calendar is shorter: give it a name, choose Gmail or forwarding, pick one example email, confirm. The usual choices (check every 7 days, read the last 30 days) are already made; tap Change to adjust them.
- When setup is done, the first button copies your calendar's share link.
- Settings shows the name and Private/Public first; everything else is under More settings.

## [0.4.0] - 2026-11-21

### Changed
- A new look: clean white and black with one orange accent, a bigger title, and black buttons.
- Calendar pages show events like a calendar app, with the day and date on the left and the next event marked. The kind and ZIP (like "School · 95818") sit above the title, and the notes for subscribers move to the bottom.

## [0.3.2] - 2026-11-21

### Changed
- Making a new calendar link, getting a new email address and disconnecting Gmail now ask you to tick a box first, because they can't be undone.
- Buttons and choices respond when you hover and press them (unless your device asks for less motion).
- A "Skip to content" link for keyboard and screen-reader users; error messages are read out by screen readers.
- Phones suggest the right things in email and ZIP fields and stop "correcting" email addresses.

### Fixed
- The Gmail example search box now looks like every other field.
- The phone's top bar matches the page colour.

## [0.3.1] - 2026-11-21

### Fixed
- The empty ZIP box no longer shows a real-looking example ZIP that could be mistaken for a filled-in value.

## [0.3.0] - 2026-11-21

### Added
- Public calendars have an area (ZIP code), so people nearby can find them. Feedcal fills it in from addresses in the calendar's emails and events; you just confirm it when you choose Public. Private calendars are never asked.
- Notes for subscribers on every calendar page and in the calendar itself: it's filled in automatically and can make mistakes, it isn't an official calendar of the groups named in it (unless the organizer is Verified), and calendar apps can take a few hours to show changes.
- The privacy policy now explains what happens when you connect Gmail.
- Approving a sender now says what that means: events with a clear date go on the calendar without asking you.

## [0.2.3] - 2026-11-21

### Changed
- Publishing on its own is now decided by date rules, for every calendar: when the email's own words prove the date (a written date, or "tomorrow" / "this Friday" that can only mean one day), an approved sender's event is published even if Feedcal is only moderately sure. If the words don't match the event, could mean two different days, or put it before the email was sent, it waits for you with a plain reason.
- Settings offers 50% and 60% as well.

## [0.2.2] - 2026-11-21

### Added
- Gmail: read earlier emails too. When you pick your example, a box (ticked by default) also reads that sender's emails from the 30 days before it. Calendars already connected get a "Read the last 30 days" button. Still only that one sender, 3 emails every 5 minutes until caught up.

## [0.2.1] - 2026-11-21

### Fixed
- Gmail: changing how often to check no longer delays reading your example email by a week.
- Gmail: a sender with many recent emails no longer stops the check; Feedcal reads a few at a time and carries on minutes later.

## [0.2.0] - 2026-11-21

### Added
- Connect Gmail instead of forwarding: show Feedcal one example email, confirm, and it checks only that sender, every 3 or 7 days. Read-only, and disconnecting deletes everything it read. (Switched on once the Gmail connection is set up for the site.)
- A big Private / Public choice when you make or edit a calendar. Private: only people with the link or QR code. Public: the same, and it can show up in Find a calendar.

### Fixed
- Settings now tells you the real reason a calendar can't be listed publicly yet, instead of "only the owner can change these settings".

## [0.1.3] - 2026-11-21

### Added
- "Sign in with Google" on the sign-in page: no email link to wait for.

## [0.1.2] - 2026-11-21

### Added
- Every page has a way to move on: a header with Your feeds and Account for organizers, and Find a calendar on public pages.
- Each calendar's Share and Email pages have the same menu as its other pages.

## [0.1.1] - 2026-11-21

### Added
- A "Support Feedcal" link to Buy Me a Coffee on the costs page and your account's support page.

### Fixed
- If a sign-in link opens in a different browser from the one you asked in, the page now explains how to finish.
- The admin console says "No admin actions yet" instead of showing an empty list.

## [0.1.0] - 2026-11-21

The first release: everything built so far, for a private beta.

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
- Subscribers can report a problem with any event from their calendar (the link is in each event), without an account; the organizer hears about it right away.
- A weekly summary for organizers: followers this week versus last, subscribe taps, events added, items to review, reports. A reminder when a feed goes quiet, and a thank-you card at 10, 50 and 100 followers. Every email has one-click unsubscribe; choices are on the account page.
- Follower counts now count Google and Outlook once each, as they fetch for many people at once.
- A public directory: search by words, ZIP code and distance (5, 10 or 25 miles) and kind of group. Only public calendars appear; "anyone with the link" calendars never do. Quiet calendars are labelled and sink.
- Public calendar pages now carry schema.org event data for search engines, and say when a calendar may be out of date.
- A "What Feedcal costs" page, and a way to support Feedcal on Buy Me a Coffee once it's set up. Supporters can link their support to their account for a badge and a thank-you, and choose whether their name appears on the supporters page. Nothing is linked or listed unless you ask.
- Download everything Feedcal holds about you, or any calendar as a file, from your account page. A plain-English privacy page says what's kept and for how long.
- Deleted accounts are now removed on schedule, 14 days after you ask.
- Feedcal can be added to your phone's home screen.
- Behind the scenes: Feedcal now watches itself (stuck emails, AI spending, failing email, overdue deletions, floods of requests) and tells the team. AI work pauses before it overspends; nothing is lost, it just waits.
- Stronger protection: the site blocks scripts from anywhere else, you're signed out when the browser closes, and repeated guessing or flooding gets slowed down.
- "Report this calendar" on every public page, and a team review queue. New accounts can share by link straight away; public listing opens after 7 days, needs a confirmed email and one published event, and spammy text waits for a quick review.
- A verified badge for organizers who use their organisation's email.
- Events that mention a phone number, email address or home address are held for the organizer to check before publishing, to keep children's details private.
- Community rules, terms and a takedown process (drafts).
- Forwarding the same email twice is harmless; Feedcal keeps one copy and deletes copies after 30 days.

### Fixed
- Edits to an event now reach calendars that already subscribed. Before, some calendar apps could ignore an edit.
- A typo in your email on the sign-in page no longer clears what you typed.
- If something breaks, you now see a plain page with a code to quote, not raw technical text.

### Security
- Sign-in emails are limited to 5 per address and 20 per network each hour.
- Problems can be reported privately; see SECURITY.md.
