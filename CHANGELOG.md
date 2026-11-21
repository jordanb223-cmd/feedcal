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
- Forwarding the same email twice is harmless; Feedcal keeps one copy and deletes copies after 30 days.

### Fixed
- Edits to an event now reach calendars that already subscribed. Before, some calendar apps could ignore an edit.
- A typo in your email on the sign-in page no longer clears what you typed.
- If something breaks, you now see a plain page with a code to quote, not raw technical text.

### Security
- Sign-in emails are limited to 5 per address and 20 per network each hour.
- Problems can be reported privately; see SECURITY.md.
