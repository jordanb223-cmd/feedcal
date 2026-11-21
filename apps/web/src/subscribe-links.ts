// Subscribe links for each calendar app.
// Google's `?cid=` and Outlook's `addfromweb` URL formats are community-documented, not in either
// vendor's official docs (D23). The plain link and copy button are always shown as a fallback.

export type Device = "apple" | "android" | "windows" | "other";

export interface SubscribeLinks {
  https: string;
  webcal: string;
  google: string;
  outlook: string;
  office365: string;
}

export function subscribeLinks(feedHttpsUrl: string, calendarName: string): SubscribeLinks {
  const webcal = feedHttpsUrl.replace(/^https?:\/\//, "webcal://");
  const name = encodeURIComponent(calendarName);
  return {
    https: feedHttpsUrl,
    webcal,
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(webcal)}&name=${name}`,
    office365: `https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(webcal)}&name=${name}`,
  };
}

/** Which button to show first. Every option is still listed under "Other ways". */
export function detectDevice(ua: string | undefined): Device {
  if (!ua) return "other";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(ua)) return "apple";
  if (/Windows/i.test(ua)) return "windows";
  return "other";
}

/** Where each counted button sends people. */
export const GO_TARGETS = {
  apple: (l: SubscribeLinks) => l.webcal,
  google: (l: SubscribeLinks) => l.google,
  outlook: (l: SubscribeLinks) => l.outlook,
  office365: (l: SubscribeLinks) => l.office365,
} as const;
export type GoTarget = keyof typeof GO_TARGETS;

/** The click-count platform for a button (Outlook.com and Microsoft 365 both count as Outlook). */
export function platformOf(target: GoTarget): "apple" | "google" | "outlook" {
  return target === "office365" ? "outlook" : target;
}
