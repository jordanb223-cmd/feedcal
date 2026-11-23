# Calantern design guide

Every page follows this file. It has four parts: what ten real sites in our niche do well, the
rules we take from them, what is banned, and the direction we chose.

**Status (2026-11-23): direction A, "Lantern paper", is chosen and built.** The owner asked for
the pick to be made for them; part 4 records it. The three mockups that were compared are in
`.design/mockups.html` (this Mac only).

## How the references were gathered

On 2026-11-23, 14 calendar and event sites were opened in Chrome at 1280 px and 390 px wide. Each
home page was screenshotted (top 1,500 px on desktop) and its type, colour and button values were
read from the live page. Ten were kept. Screenshots and the raw values are in `.design/refs/`
(kept on this Mac only, not in the public repo: they are other companies' pages).

What this does not cover: only home pages, only the top of each page, one visit each, signed out.
Cookie banners covered part of four pages (Notion Calendar, TimeTree, Cozi, TeamSnap). Inner
pages, sign-up flows and the apps themselves were not looked at. Numbers below are given only
where the reading clearly landed on the main headline or main button.

## Part 1. The ten references

| # | Site | Headline (desktop / phone) | Type | Colour | Main button |
|---|------|----------------------------|------|--------|-------------|
| 1 | [SavvyCal](https://savvycal.com) | 88 / 56 px, bold, left | Condensed serif headline (GT Alpina Condensed), sans body | Cream page `rgb(252,247,237)`, one red-orange `rgb(245,67,32)`, a deep green panel | Full pill, red-orange, no shadow |
| 2 | [Luma](https://lu.ma) | 80 / 40 px, medium weight, centred | System font throughout | White, near-black text, grey subtext, colour only in two headline words | Black pill |
| 3 | [Partiful](https://partiful.com) | 74 px, all caps, centred | Heavy condensed display face, light grotesk body | Black hero, white and light grey below | White square-cornered block on black |
| 4 | [Cal.com](https://cal.com) | 80 / 42 px, bold, centred | One custom display sans (Cal Sans) | White, `rgb(36,36,36)` ink, grey subtext | Near-black, 12 px corners |
| 5 | [Notion Calendar](https://www.notion.com/product/calendar) | 64 / 42 px, bold, tight (-2 px tracking), centred | Their own Inter cut | White, black, pastel event colours | Near-black, 8 px corners |
| 6 | [Fantastical](https://flexibits.com/fantastical) | 40 / 32 px, medium, centred | Humanist sans (Effra) | White with large soft colour tiles at the edges, blue buttons | Blue pill, flat |
| 7 | [TimeTree](https://timetreeapp.com) | 55 / 22 px, bold, centred | System font | A full green field `rgb(32,216,140)` fading to yellow | Green, 8 px corners, dark text |
| 8 | [Cozi](https://www.cozi.com) | Large bold white on blue, left (not measured) | Rounded geometric sans, Open Sans body | A full blue field, white text, orange sign-up | White pill, blue text |
| 9 | [AddEvent](https://www.addevent.com) | Two lines, left, key words in blue (not measured) | Circular-style geometric sans | White, black, one blue `rgb(18,94,248)` | Blue, 6 px corners, with a small arrow |
| 10 | [Howbout](https://howbout.app) | 68 / 32 px, bold, tight (-2 px), left | Display sans (Bagoss), plain sans body | Near-black page, white text, an orange-pink phone glow | App-store badges only |

### What makes each one work

1. **SavvyCal.** The cream page and one hot colour make it feel like stationery, not software.
   The headline is two lines: the first in ink, the second in the accent. Everything is
   left-aligned to one edge. Below the fold line, a real calendar sits on a dark green panel, so
   the product is the picture.
2. **Luma.** Almost nothing on the page: logo, three-line headline, one sentence, one button, one
   text link. The empty space is the design. Real events with real cover art start right below.
3. **Partiful.** A poster. Black ground, a shouted all-caps headline, two flat buttons. The
   picture is a group chat, which shows the moment the product is for instead of the product.
4. **Cal.com.** Small product pieces sit inside the headline itself (a booked-call chip, a
   clock). Two equal sign-up buttons, then a large product window. One typeface does everything.
5. **Notion Calendar.** A three-word headline ("It's time.") at heavy weight, then the calendar
   on a laptop and a phone. Small pastel icon tiles float at the edges and repeat the event
   colours used inside the product.
6. **Fantastical.** The app icon and name lead. Colour comes from big translucent tiles pushed to
   the corners, so the middle stays calm. Buttons are flat tinted pills.
7. **TimeTree.** One flat brand colour fills the whole first screen. A phone calendar with
   hand-drawn family faces sits in the middle. It reads as "for families" in one second.
8. **Cozi.** Same idea in blue: a full colour field, a short promise ("The Whole Family. Finally
   In Sync."), one white button, and a row of plain ticks ("Cozi is free", "iPhone, Android &
   Web") that answer the first questions.
9. **AddEvent.** The closest to what Calantern does. The headline is the job in plain words:
   "Get your events on your attendees' calendars". Lots of white space, one blue, one button and
   one outlined button. Trust is a single quiet line with a number.
10. **Howbout.** A dark page with one glowing phone. The headline is conversational and long, set
    large and tight on the left; the phone balances it on the right.

### Looked at and not followed

- **Amie**: now sells AI agents; Inter, a blue button and a screenshot. Nothing to learn for us.
- **Skylight**: a shop page with a sale banner and countdown.
- **TeamSnap**: youth sports, so in our niche, but dark blue glow panels and gradient bands.
- **Doodle**: a stock photo hero and a serif-then-sans headline trick.

## Part 2. Rules we take from them

Counts are out of the ten references, from the screenshots.

1. **Show the calendar.** Eight of ten put the product or a phone above the fold (all but Luma
   and AddEvent). Calantern's home page shows no calendar at all. Every public page gets a real
   picture of what it makes: an email turning into an event, or an event list.
2. **One promise, in plain words, set big.** Of the eight headlines measured, seven run 55 to 88 px
   on desktop (Fantastical's is 40) and six of seven run 32 to 56 px on a phone (TimeTree's is
   22). Ours is 40 px on both. Go to at least 56 px on desktop and 40 px on
   a phone, with tight line height (1.0 to 1.1).
3. **One ink, one accent.** Most keep to a single accent on a neutral or single-colour ground.
   Fantastical and Notion Calendar are the exceptions, and they take their colours from the
   events inside the product. Body text is near-black. Our accent stays the lantern orange
   `#c2410c` unless the chosen direction says otherwise; it is the one thing already ours.
4. **One main button per screen.** Every reference has one filled button and at most one quieter
   companion. A page never shows two filled buttons of equal weight. Destructive actions are
   never the same size as the main one.
5. **Flat buttons.** In the screenshots, seven of the ten main buttons are flat. Luma's and
   Cal.com's carry a shadow, and Howbout shows only store badges. Corners are either a full pill
   or 6 to 12 px. Pick one and use it everywhere.
6. **Pick an edge.** Pages are either fully centred (Luma, Cal.com, Notion) or fully
   left-aligned (SavvyCal, AddEvent, Howbout). None mix. Each Calantern page picks one.
7. **Say the first answers right under the button.** Cozi's ticks and SavvyCal's guarantee line
   do this. Ours: "Free. No app. Works with iPhone, Google and Outlook."
8. **Space is part of it.** Luma and AddEvent leave half the first screen empty. On our dense
   pages (Email, Share, Account) this means fewer cards, not smaller text.

### Rules from Calantern itself

- **Phone first.** A teacher prints one QR code; families open it on a phone. Every page is
  designed at 375 px wide first and must have no sideways scroll.
- **Contrast.** Text meets WCAG AA (4.5:1). Any new colour pair is computed, not guessed.
- **The flyer prints.** The flyer page must stay black on white and scan at arm's length.
- **Fonts are served by us.** The site allows styles and scripts only from its own address, and
  no outside fonts. A new typeface means self-hosted font files and one added line in the
  security policy (`font-src 'self'`). Two families at most.
- **No scripts in the page.** Behaviour hangs on data attributes and the one script file.
  Small animations are CSS only and stop under "reduce motion".
- **Words.** "Calendar", never "feed", in anything a person reads.

## Part 3. Banned

If a page looks like every other AI-made site, it starts over. Specifically:

- No Inter. (Three of the references use it; that is the reason not to.)
- No purple gradients. No gradient text.
- No glowing buttons, glowing phones or blurred colour blobs.
- No serif headline with one word in italic.
- No row of four stat cards. No invented numbers, quotes or logos of any kind.
- No centred hero followed by three identical icon cards.
- No emoji as icons or decoration.
- No pill badge above the headline announcing something ("New", "Product of the Day").

## Part 4. Chosen direction: Lantern paper

Built from SavvyCal (cream page, serif headline, one hot colour, one left edge) with AddEvent's
plain wording. It was picked over "Flyer" (black and marigold, from Partiful) and "Agenda"
(calendar-app look, from Notion Calendar) because it is the only one that keeps the lantern
orange and does not look like other calendar software. It should feel like a note sent home from
school.

The stylesheet is one string in `apps/web/src/assets.ts`. Its first lines define every value
below as a CSS variable; pages use the variables and never a raw colour.

### Colour

| Token | Value | Used for | Contrast |
|-------|-------|----------|----------|
| `--paper` | `#f6efe2` | Page background | |
| `--card` | `#fffaf0` | Panels | |
| `--ink` | `#1c1813` | Text, the main button | 15.4:1 on paper |
| `--soft` | `#5e5546` | Secondary text | 6.4:1 on paper, 7.1:1 on card |
| `--accent` | `#c2410c` | Fills: the brand dot, date-tile band, tab underline | white on it 5.2:1 |
| `--accent-text` | `#b23a08` | Orange text (kickers, step numbers, the headline's second line) | 5.2:1 on paper |
| `--line` | `#e2d6bf` | Hairlines and panel borders | |
| `--field` | `#857a66` | Input borders | 3.7:1 on paper |
| `--danger` | `#8a1c1c` | Destructive buttons and errors | white on it 9.3:1 |
| `--ring` | `#1a4fd6` | Keyboard focus ring | 5.9:1 on paper |

Orange text always uses `--accent-text`; plain `--accent` on paper is 4.53:1, too close to the
limit for small text.

### Type

- **Headlines:** Young Serif 400 (one file, 27 KB, served from `/fonts`, from the pinned
  `@fontsource/young-serif` package, OFL licence). Fallback: Iowan Old Style, Palatino, Georgia.
  Never bold, never italic, never all caps.
- **Everything else:** the device's own sans (San Francisco, Segoe UI, Roboto). No second web
  font, so text is instant and familiar.
- **Sizes:** home headline 42 px on a phone, 56 px from 640 px wide; page titles 32 px; section
  titles 22 px; body 16 px / 1.5; small print 14 px. Headline line height 1.0 to 1.05.
- **Kicker:** 13 px, bold, capitals, 0.09em tracking, orange. At most one per panel.

### Shape and space

- A page is open sections divided by a hairline, each with a serif heading. Only the one main
  thing on a page sits in a panel (12 px corners, 1 px line, 20 px padding): the subscribe
  block, the event waiting for a decision, the sign-in form. Never a stack of identical panels.
- Buttons: full pill, at least 46 px tall. Filled ink = the one main action on the screen.
  Outlined = everything else. Destructive = red outline at rest, filled only on hover, and never
  the first button on a page. Small repeated actions inside a list are text links, not pills.
- Inputs: 10 px corners, at least 46 px tall, label above in semibold.
- Phones and most pages: one column, 480 px wide at most, left-aligned. Centre only the flyer.
- From 960 px wide, the home page and the public calendar page use the width (1,056 px): pitch
  left and the email-becomes-event demo right; three steps across; the event list beside the
  subscribe panel. Organizer pages stay one column on every screen for now.
- Date tile: 46 px wide, ink outline, a coloured band with the weekday, the day in the serif.
  The next event's band is orange; later ones are grey-brown.
- A calendar's menu is five tabs that fit a 375 px phone: Review, Add event, Share, Email,
  Settings. It always sits directly under the page title. The way back to all calendars is the
  site header; Gmail is reached from the Email page.

### Components (the shadcn/ui question)

shadcn/ui and Magic UI are React libraries. Calantern has no React: pages are HTML built on the
server, and the security policy forbids the inline scripts and styles those libraries inject. So
the site follows their conventions in plain CSS instead of installing them:

- Named tokens for every colour and radius (as above), like shadcn's `--background`,
  `--foreground`, `--primary`, `--muted-foreground`, `--border`, `--ring`.
- Every interactive element has four visible states: rest, hover, focus (3 px ring, 2 px
  offset) and pressed (scales to 97%). Disabled is 55% opacity.
- Variants by class, not one-off styles: `button`, `.secondary`, `.danger`, `.wide`.

### Motion (the Magic UI question)

Small and CSS-only. The home page's email slip, the "becomes" line and the event rise in one
after another (half a second each). Opened sections rise in over 0.2 s. Buttons ease colour over
0.15 s. Everything stops under "reduce motion". Nothing loops, glows or follows the pointer.

### Judged by a stranger

On 2026-11-23 a fresh reviewer with no knowledge of the project was given seven screenshots of
the first build and the SavvyCal, AddEvent and Luma home pages, and asked to be harsh. It scored
the site **5.5 out of 10** (home on a phone 6.5, home on desktop 4, Email page 3). Its three
changes to reach a 9, and what was done:

1. **Build a real desktop layout.** Done for the home page and the public calendar page. Not
   done for organizer pages (it suggested a sidebar).
2. **Kill the uniform card; one solid button per page; no emoji.** Done: open sections, one
   panel per page, red-outline destructive buttons, the Private / Public symbols removed.
3. **Rebuild the Email page as a compact list.** Done: one row per email, files indented
   beneath, actions as text links, local time, the how-to folded away. On the test data the page
   went from 5,580 px to about 3,500 px tall at phone width.

The rebuilt pages have not been re-scored. Its other notes that were acted on: the tilted email
slip is straight, the duplicate "Find a calendar" on the home page is gone, "Coming up" uses the
same date tiles on both sides, the footer no longer wraps with stray dots, and the tab bar no
longer clips.

### Still to do

- The home page's second line is SavvyCal's idea (ink line, then accent line). The reviewer
  called it derivative. Worth a second idea of our own.

Done since (D69): on wide screens Share, Account and Review use two columns, and other organizer
pages are a little wider (36rem). Share and Account each fold their rare, risky action away, and
Account no longer repeats the calendar list. A picture that fails to load is hidden instead of
showing a broken box. Still one column on wide screens: Email, Settings, Add event.
