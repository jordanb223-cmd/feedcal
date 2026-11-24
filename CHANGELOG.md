# Changelog

What changed in Feedcal, written for the people who run calendars with it. Newest first.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

A production release is a tag `vX.Y.Z`. The deploy refuses to run unless this file has a `## [X.Y.Z]` section.

## [Unreleased]

## [0.13.1] - 2026-11-24

### Fixed
- A picture or scan waiting on the daily reading limit is now read as soon as you have pages left, not when the date changes. Before, it waited until 4 PM Pacific the next day even if there was room.

## [0.13.0] - 2026-11-24

### Changed
- Calantern can read up to 100 pictures a day for you. The limit was 20, set when reading a picture cost much more.
- When the two AI readings of a picture disagree, a third reads it and settles it. Before, any disagreement came to you. Now it only comes to you when all three read it differently.
- If one AI model is busy or down, another takes its place, so an email doesn't sit unread.
- If Calantern reads an email again and gets a different day for an event that is already on your calendar, it asks you with a "Different time?" card. Before, the calendar's version won without telling you.

### Fixed
- A scanned file is now read whole or left for the next day. Before, if the day's limit ran out partway through, the remaining pages were never read.

## [0.12.0] - 2026-11-23

### Added
- When Calantern adds, changes or cancels an event by itself, it emails you right away. The email lists each change with the exact words it was read from and a link to fix or remove it. You can switch these off on your account page or from the email.

### Changed
- An event whose date has already passed is no longer created, however late its email is read. No more drafts for last week.
- Emails that had to wait are retried for 8 days, not 30. Older mail is about dates that have gone by.

### Fixed
- When Calantern reads the same email again, it no longer adds second copies. Before, each re-read could leave another draft or another "check this one" card for an event you already had, because the wording came out slightly different each time. Now a re-read updates the draft that email already made, leaves published events alone, and does not bring back anything you discarded or rejected.
- Something that runs over several days, like "November 26 & 27 – no school", is now one event covering both days instead of a separate event for one of them.
- A picture already found to have no text is not read again when its email is retried.

## [0.11.0] - 2026-11-23

### Changed
- Pictures are now read in two passes, to cost less and catch misread dates. A fast, low-cost AI model reads every picture. If the picture shows a date or time, a stronger model reads it again, and the two must agree. If they disagree, the event waits for you with the note "Read from an image; compare with the picture."
- The second opinion on unclear events, and the reasoning about unclear days, now use a mid-priced AI model instead of the most expensive one.
- An email can carry up to 20 attachments. The limit was 10.
- There is no longer a limit of five pages per email. From each file Calantern reads up to 30 pages: the 30 most likely to hold dates, or the first 30 of a scanned file. Before, a scanned file got two pages and a file over 40 pages was skipped whole. Size: a single file over 15 MB is skipped, and the files read from one email stop once they add up to 15 MB.
- When an email has a newsletter and photos, the newsletter is read first.
- Files that were skipped under the old limits are read again on their own.

### Fixed
- When a parked email is retried, pictures that were already read are kept as they are and not read (and paid for) a second time.

## [0.10.0] - 2026-11-23

### Fixed
- Photos, scans and picture-only PDFs that arrived before image reading was switched on are now read on their own. Before, they stayed on "Waiting" for good unless you tapped "This one has the schedule". The same goes for files that hit the day's page limit: they are tried again the next day.

### Changed
- Calantern now publishes an event on its own when it is at least 70% sure, down from 85%. This is the standard setting; a calendar that chose its own level keeps it. The same level now applies to changes, so a moved or cancelled event from a trusted sender at 70% or more updates without asking.
- When an email's wording fits more than one day ("this Friday", sent on a Friday), Calantern now reasons it out from the rest of the email. If the email settles it, the event is published. If it doesn't, the event still waits for you.
- When an email gives no time for an event, the event is kept as an all-day event. Before, an event with a guessed time was dropped.
- Events read from a photo, a scan or a picture-only PDF can now be published without asking you, but only when Calantern is at least 85% sure (or your calendar's own level, if you set it higher). Typed text needs 70%. Pictures get the higher level because reading one can misread a date. Before, these events always waited for you.

## [0.9.1] - 2026-11-23

### Fixed
- Emails that had to wait (your daily limit was reached, or AI reading was paused) are now picked up again on their own, every hour. Before, they waited until someone restarted them by hand.
- With Gmail connected, an email that arrived after the day's limit was reached is no longer skipped for good. Calantern tries it again an hour later.
- Calendars copied from a calendar link: a repeating event now stays on your public page and your "Coming up" list, shown at its next date and marked "Repeats". Before, it disappeared after its first date.
- Calendars copied from a calendar link: when one date in a repeating event was moved or removed at the source, Calantern now keeps the series and shows the change. Before, the moved date replaced the whole series.
- A photo your browser can't show no longer leaves a broken-image box on the Email page.
- The takedown page pointed to a report option that doesn't exist. It now points to the contact form.

### Changed
- On a computer screen, the Share, Account and Review pages use two columns instead of one narrow one.
- The Share page tucks "Make a new calendar link" away until you open it. The Account page does the same for "Delete your account", and no longer repeats your list of calendars.
- The privacy page says which country Calantern's data is stored in.

### Added
- Admins can show a hidden calendar again from the admin page.

## [0.9.0] - 2026-11-23

### Changed
- Calantern has a new look: a warm paper background, one orange accent, and a new headline typeface. Buttons are flat and there is one main button per page.
- Each calendar now has a row of five tabs: Review, Add event, Share, Email and Settings.
- The Email page is shorter. Recent emails are a compact list, the how-to and spam sections are folded away until you open them, and times show in your calendar's timezone.
- Upcoming events show as date tiles on your calendar's page and on the public page.
- The home page shows an email turning into a calendar event, with one "Make a calendar" button.

### Security
- Calantern's background jobs now refuse to start for a signed-in person's own session. Only the scheduler can start them.
- Visitors can no longer read the internal id of a public calendar's owner. It was never a name or an email address.

## [0.8.6] - 2026-11-23

### Added
- A page that shows how to stop following a calendar in Apple Calendar, Google Calendar and Outlook. Every email from Calantern links to it, and so does the last line of every event. Your calendar app shows the new line after its next refresh.

### Changed
- Emails from Calantern are friendlier and easier to read. The weekly email starts with what needs you, and the follower number is now a small line marked as a rough guess. The "10, 50 or 100 followers" email is a thank-you first.
- Your calendars now show as Private or Public everywhere.

### Fixed
- Photo thumbnails on the Email page, and pictures on review cards, now load.
- "Trust" and "Stop using" in Settings keep you on Settings.
- An email with an unreadable date no longer gets stuck; Calantern uses the time it arrived.
- Bounce messages and the data export file name say Calantern.

## [0.8.5] - 2026-11-22

### Fixed
- Same as 0.8.4, which wasn't released: its deploy would have recorded the pre-deploy backup before the database had the place to record it. The deploy now records it after updating the database.

## [0.8.4] - 2026-11-22

### Fixed
- Backups now run four times a day, and the admins get an email if none has arrived in 30 hours.

## [0.8.3] - 2026-11-22

### Added
- Every event in a Calantern calendar now ends with a short line saying it was added by Calantern, for which calendar, and to check important details with the organizer. Your calendar app shows it after its next refresh.

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
